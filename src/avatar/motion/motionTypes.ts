export const MOTION_MANIFEST_SCHEMA_VERSION = 1 as const;

export const MOTION_TAGS = [
  'greeting',
  'reaction',
  'walk',
  'jog',
  'celebration',
  'surprise',
  'apology',
  'idle',
] as const;

export type MotionTag = (typeof MOTION_TAGS)[number];
export type MotionSource = 'saved' | 'ardy';
export type MotionFormat = 'vrma';

export interface MotionManifestEntry {
  assetId: string;
  file: string;
  source: 'saved';
  tags: readonly MotionTag[];
  durationMs: number;
  fps: number;
  loop: boolean;
  correctionProfileId: string;
  contentSha256: string;
}

export interface MotionManifest {
  schemaVersion: typeof MOTION_MANIFEST_SCHEMA_VERSION;
  avatarSha256?: string | null;
  assets: readonly MotionManifestEntry[];
}

export interface MotionAssetDescriptor {
  schemaVersion: typeof MOTION_MANIFEST_SCHEMA_VERSION;
  assetId: string;
  format: MotionFormat;
  source: MotionSource;
  url: string;
  durationMs: number;
  fps: number;
  loop: boolean;
  tags: readonly MotionTag[];
  correctionProfileId: string;
  contentSha256: string;
  expiresAt?: string;
}

export interface MotionRequest {
  schemaVersion: typeof MOTION_MANIFEST_SCHEMA_VERSION;
  requestId: string;
  planId: string;
  prompt?: string;
  durationMs?: number;
  seed?: number;
  correctionProfileId: string;
  sourcePolicy: 'saved_only' | 'saved_then_ardy';
}

export interface MotionProvider {
  generate(
    request: MotionRequest,
    signal: AbortSignal,
  ): Promise<MotionAssetDescriptor>;
}

export interface MotionCorrectionProfile {
  schemaVersion: typeof MOTION_MANIFEST_SCHEMA_VERSION;
  profileId: string;
  targetAvatarSha256: string | null;
  calibrationStatus: 'pending-owner-playcheck' | 'verified';
  units: {
    rotation: 'degrees';
    translation: 'meters';
    scale: 'ratio';
  };
  upperBody: {
    upperArmSpreadDegrees: { left: number; right: number };
    armSwingScale: number;
    elbowFlexionDegrees: { left: number; right: number };
    shoulderElevationDegrees: { left: number; right: number };
  };
  lowerBody: {
    stanceWidthScale: number;
    stepWidthScale: number;
    rootMotionScale: number;
    pelvisMotionScale: number;
  };
  secondary: {
    headYawDegrees: number;
    headPitchDegrees: number;
    wristRotationDegrees: number;
  };
}

export interface MotionPlaybackProfile {
  profileId: string;
  hipsTranslationScale: number;
  hipsRotationScale: number;
  spineRotationScale: number;
  chestRotationScale: number;
  upperChestRotationScale: number;
  neckRotationScale: number;
  headRotationScale: number;
  lookAtRotationScale: number;
}

const ASSET_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MOTION_FILE_PATTERN = /^[^/\\]+\.vrma$/i;

export class MotionManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MotionManifestError';
  }
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new MotionManifestError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function asNonEmptyString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new MotionManifestError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function asFinitePositiveNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new MotionManifestError(`${label} must be a positive number.`);
  }
  return value;
}

function asFinitePositiveInteger(value: unknown, label: string): number {
  const number = asFinitePositiveNumber(value, label);
  if (!Number.isInteger(number)) {
    throw new MotionManifestError(`${label} must be an integer.`);
  }
  return number;
}

function parseTags(value: unknown, label: string): MotionTag[] {
  if (!Array.isArray(value)) {
    throw new MotionManifestError(`${label} must be an array.`);
  }

  const tags: MotionTag[] = [];
  for (const candidate of value) {
    if (
      typeof candidate !== 'string' ||
      !(MOTION_TAGS as readonly string[]).includes(candidate)
    ) {
      throw new MotionManifestError(`${label} contains an unknown tag.`);
    }
    if (!tags.includes(candidate as MotionTag)) {
      tags.push(candidate as MotionTag);
    }
  }
  return tags;
}

function parseManifestEntry(
  value: unknown,
  index: number,
): MotionManifestEntry {
  const record = asRecord(value, `assets[${index}]`);
  const assetId = asNonEmptyString(record.assetId, `assets[${index}].assetId`);
  const file = asNonEmptyString(record.file, `assets[${index}].file`);
  const source = record.source;
  const correctionProfileId = asNonEmptyString(
    record.correctionProfileId,
    `assets[${index}].correctionProfileId`,
  );
  const contentSha256 = asNonEmptyString(
    record.contentSha256,
    `assets[${index}].contentSha256`,
  );

  if (!ASSET_ID_PATTERN.test(assetId)) {
    throw new MotionManifestError(
      `assets[${index}].assetId must use lowercase kebab-case.`,
    );
  }
  if (!MOTION_FILE_PATTERN.test(file) || file.includes('..')) {
    throw new MotionManifestError(
      `assets[${index}].file must be a direct .vrma filename.`,
    );
  }
  if (source !== 'saved') {
    throw new MotionManifestError(
      `assets[${index}].source must be saved for curated assets.`,
    );
  }
  if (!PROFILE_ID_PATTERN.test(correctionProfileId)) {
    throw new MotionManifestError(
      `assets[${index}].correctionProfileId must use lowercase kebab-case.`,
    );
  }
  if (!SHA256_PATTERN.test(contentSha256)) {
    throw new MotionManifestError(
      `assets[${index}].contentSha256 must be a lowercase SHA-256 hash.`,
    );
  }
  if (typeof record.loop !== 'boolean') {
    throw new MotionManifestError(`assets[${index}].loop must be boolean.`);
  }

  return {
    assetId,
    file,
    source,
    tags: parseTags(record.tags, `assets[${index}].tags`),
    durationMs: asFinitePositiveInteger(
      record.durationMs,
      `assets[${index}].durationMs`,
    ),
    fps: asFinitePositiveNumber(record.fps, `assets[${index}].fps`),
    loop: record.loop,
    correctionProfileId,
    contentSha256,
  };
}

export function parseMotionManifest(value: unknown): MotionManifest {
  const record = asRecord(value, 'motion manifest');
  if (record.schemaVersion !== MOTION_MANIFEST_SCHEMA_VERSION) {
    throw new MotionManifestError(
      `schemaVersion must be ${MOTION_MANIFEST_SCHEMA_VERSION}.`,
    );
  }
  if (!Array.isArray(record.assets)) {
    throw new MotionManifestError('assets must be an array.');
  }

  const avatarSha256 = record.avatarSha256;
  if (
    avatarSha256 !== undefined &&
    avatarSha256 !== null &&
    (typeof avatarSha256 !== 'string' || !SHA256_PATTERN.test(avatarSha256))
  ) {
    throw new MotionManifestError(
      'avatarSha256 must be null or a lowercase SHA-256 hash.',
    );
  }

  const assets = record.assets.map(parseManifestEntry);
  const assetIds = new Set<string>();
  for (const asset of assets) {
    if (assetIds.has(asset.assetId)) {
      throw new MotionManifestError(
        `assetId is duplicated: ${asset.assetId}.`,
      );
    }
    assetIds.add(asset.assetId);
  }

  return {
    schemaVersion: MOTION_MANIFEST_SCHEMA_VERSION,
    ...(avatarSha256 === undefined ? {} : { avatarSha256 }),
    assets,
  };
}
