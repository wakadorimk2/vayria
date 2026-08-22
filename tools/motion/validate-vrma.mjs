import { readFile } from 'node:fs/promises';

const JSON_CHUNK_TYPE = 0x4e4f534a;
const BIN_CHUNK_TYPE = 0x004e4942;
const GLB_MAGIC = 0x46546c67;
const GLB_VERSION = 2;

function readArgument(name) {
  const index = process.argv.indexOf(name);
  if (index === -1 || !process.argv[index + 1]) {
    throw new Error(`Missing required argument: ${name}`);
  }
  return process.argv[index + 1];
}

function assertCondition(condition, message) {
  if (!condition) throw new Error(message);
}

function readJsonChunk(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertCondition(bytes.byteLength >= 12, 'The file is smaller than a GLB header.');
  assertCondition(view.getUint32(0, true) === GLB_MAGIC, 'The file is not a GLB.');
  assertCondition(view.getUint32(4, true) === GLB_VERSION, 'The GLB version must be 2.');

  const declaredLength = view.getUint32(8, true);
  assertCondition(
    declaredLength === bytes.byteLength,
    'The GLB declared length does not match the file length.',
  );

  let json = null;
  let binByteLength = 0;
  for (let offset = 12; offset < declaredLength; ) {
    assertCondition(offset + 8 <= declaredLength, 'The GLB chunk header is truncated.');
    const chunkLength = view.getUint32(offset, true);
    const chunkType = view.getUint32(offset + 4, true);
    const chunkStart = offset + 8;
    const chunkEnd = chunkStart + chunkLength;
    assertCondition(chunkEnd <= declaredLength, 'The GLB chunk is truncated.');

    if (chunkType === JSON_CHUNK_TYPE) {
      const jsonText = new TextDecoder().decode(bytes.subarray(chunkStart, chunkEnd)).trim();
      json = JSON.parse(jsonText);
    }
    if (chunkType === BIN_CHUNK_TYPE) binByteLength += chunkLength;
    offset = chunkEnd;
  }

  assertCondition(json !== null, 'The GLB does not contain a JSON chunk.');
  return { json, binByteLength };
}

function readIndex(value, label) {
  assertCondition(Number.isInteger(value) && value >= 0, `${label} must be a non-negative integer.`);
  return value;
}

function validateAccessor(gltf, accessorIndex, binByteLength, label) {
  const accessors = Array.isArray(gltf.accessors) ? gltf.accessors : [];
  const bufferViews = Array.isArray(gltf.bufferViews) ? gltf.bufferViews : [];
  const accessor = accessors[readIndex(accessorIndex, `${label}.accessor`)];
  assertCondition(accessor && typeof accessor === 'object', `${label} accessor is missing.`);
  assertCondition(Number.isInteger(accessor.count) && accessor.count > 0, `${label} accessor count is invalid.`);
  assertCondition(typeof accessor.type === 'string', `${label} accessor type is missing.`);
  const viewIndex = readIndex(accessor.bufferView, `${label}.bufferView`);
  const bufferView = bufferViews[viewIndex];
  assertCondition(bufferView && typeof bufferView === 'object', `${label} bufferView is missing.`);
  const byteOffset = Number.isInteger(bufferView.byteOffset) ? bufferView.byteOffset : 0;
  const byteLength = bufferView.byteLength;
  assertCondition(Number.isInteger(byteLength) && byteLength > 0, `${label} bufferView length is invalid.`);
  assertCondition(byteOffset >= 0 && byteOffset + byteLength <= binByteLength, `${label} bufferView is outside the BIN chunk.`);
}

function validateAnimations(gltf, binByteLength) {
  const extensionsUsed = Array.isArray(gltf.extensionsUsed) ? gltf.extensionsUsed : [];
  assertCondition(
    extensionsUsed.includes('VRMC_vrm_animation'),
    'The GLB does not declare VRMC_vrm_animation.',
  );
  const animationExtension = gltf.extensions?.VRMC_vrm_animation;
  assertCondition(animationExtension && typeof animationExtension === 'object', 'VRMC_vrm_animation is missing.');
  assertCondition(
    animationExtension.specVersion === undefined ||
      animationExtension.specVersion === '1.0' ||
      animationExtension.specVersion === '1.0-draft',
    'The VRMA spec version must be 1.0 or 1.0-draft when it is declared.',
  );
  assertCondition(
    animationExtension.humanoid?.humanBones?.hips?.node !== undefined,
    'The VRMA humanoid hips node is missing.',
  );

  const nodes = Array.isArray(gltf.nodes) ? gltf.nodes : [];
  const animations = Array.isArray(gltf.animations) ? gltf.animations : [];
  assertCondition(animations.length > 0, 'The GLB contains no animation.');

  for (const [animationIndex, animation] of animations.entries()) {
    assertCondition(animation && typeof animation === 'object', `animations[${animationIndex}] is invalid.`);
    assertCondition(
      Number.isFinite(animation.duration) && animation.duration > 0,
      `animations[${animationIndex}].duration is invalid.`,
    );
    assertCondition(Array.isArray(animation.channels) && animation.channels.length > 0, `animations[${animationIndex}] has no channels.`);
    const samplers = Array.isArray(animation.samplers) ? animation.samplers : [];
    for (const [channelIndex, channel] of animation.channels.entries()) {
      const samplerIndex = readIndex(channel.sampler, `animations[${animationIndex}].channels[${channelIndex}].sampler`);
      const sampler = samplers[samplerIndex];
      assertCondition(sampler && typeof sampler === 'object', `animations[${animationIndex}] sampler is missing.`);
      validateAccessor(gltf, sampler.input, binByteLength, `animations[${animationIndex}].samplers[${samplerIndex}].input`);
      validateAccessor(gltf, sampler.output, binByteLength, `animations[${animationIndex}].samplers[${samplerIndex}].output`);
      const nodeIndex = readIndex(channel.target?.node, `animations[${animationIndex}].channels[${channelIndex}].target.node`);
      assertCondition(nodeIndex < nodes.length, `animations[${animationIndex}] target node is missing.`);
      assertCondition(
        channel.target?.path === 'rotation' || channel.target?.path === 'translation',
        `animations[${animationIndex}] has an unsupported target path.`,
      );
    }
  }

  return animations.length;
}

async function main() {
  const filePath = readArgument('--file');
  const bytes = new Uint8Array(await readFile(filePath));
  const { json, binByteLength } = readJsonChunk(bytes);
  const animationCount = validateAnimations(json, binByteLength);
  console.log(`Validated VRMA: ${filePath} (${animationCount} animation(s))`);
}

main().catch((error) => {
  console.error(`VRMA validation failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
