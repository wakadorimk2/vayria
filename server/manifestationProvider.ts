import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import sharp from 'sharp';
import { createGenerationTrace, traceMark } from './manifestationTrace.js';
import { type GenerationTrace } from '../src/manifestation/types.js';
import type { GeneratedObject, ManifestationMode } from '../src/manifestation/types.js';

export interface ManifestationConfig {
  provider: 'fal' | 'runware';
  mode: Exclude<ManifestationMode, 'static-fallback'>;
  resolution: '480p' | '768p';
  expansion?: 'balanced' | 'fast';
  transport?: 'queue' | 'direct';
  inputMode?: 'inline' | 'hosted';
  delivery?: 'stored' | 'stream';
  seed?: number;
  falKey?: string;
  runwareKey?: string;
}
export const CHICKEN_IMAGE_PROMPT = 'One adorable white chicken, full body centered with 20 percent empty margin, soft painted anime game prop, lavender shadows, warm light from upper left. Pure uniform vivid green RGB 0 255 0 background. No floor, cast shadow, text, person or green on the chicken.';
export const CHICKEN_VIDEO_PROMPT = 'Locked camera, one cute chicken gently bobs and blinks in place. Keep the complete silhouette inside frame with a wide margin. Preserve the perfectly uniform green background, no floor, no camera movement, no cuts, no text, no additional subjects.';
type Json = Record<string, unknown>;
let hostedSource: { hash: string; bytes: Buffer } | undefined;
const delay = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 150);
  if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
});
export async function generateManifestation(config: ManifestationConfig, reserve: (usd: number) => void, signal: AbortSignal, fetchImpl = fetch, trace: GenerationTrace = createGenerationTrace()): Promise<GeneratedObject> {
  const mark = (name: string) => traceMark(trace, name);
  const timings: Record<string, number> = { requestStartedAt: Date.now() };
  const key = config.provider === 'fal' ? config.falKey : config.runwareKey;
  if (!key) throw new Error(`missing-${config.provider}-key`);
  const post = async (url: string, body: unknown, auth: string) => {
    const r = await fetchImpl(url, { method: 'POST', headers: { Authorization: auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!r.ok) throw new Error(`provider-http-${r.status}`);
    return await r.json() as Json;
  };
  const fal = async (model: string, input: Json) => {
    const stage = model.includes('image-to-video') ? 'video' : model.includes('birefnet') ? 'mask' : 'image';
    mark(`${stage}.submitStart`);
    if (config.transport === 'direct') {
      trace.missing.push(`${stage}: direct transport has no queue observations`);
      const response = await fetchImpl(`https://fal.run/${model}`, { method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal });
      mark(`${stage}.responseHeaders`);
      const id = response.headers.get('x-fal-request-id'); if (id) trace.requestIds.push(id);
      if (!response.ok) throw new Error(`provider-http-${response.status}`);
      const result = await response.json() as Json; mark(`${stage}.responseReceived`); return result;
    }
    const task = await post(`https://queue.fal.run/${model}`, input, `Key ${key}`);
    mark(`${stage}.submitAccepted`);
    const id = task.request_id;
    if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new Error('invalid-task');
    trace.requestIds.push(id);
    // Use provider-returned queue paths only after strict origin validation.
    const safe = (value: unknown) => { const u = new URL(String(value)); if (u.origin !== 'https://queue.fal.run') throw new Error('invalid-queue-url'); return u.href; };
    const statusUrl = safe(task.status_url), resultUrl = safe(task.response_url);
    try {
      while (true) {
        signal.throwIfAborted();
        const r = await fetchImpl(statusUrl, { headers: { Authorization: `Key ${key}` }, signal });
        if (!r.ok) throw new Error(`queue-http-${r.status}`);
        const status = await r.json() as Json;
        const observed = `${stage}.observed.${String(status.status)}`;
        if (!(observed in trace.server)) mark(observed);
        trace.server[`${stage}.pollCount`] = (trace.server[`${stage}.pollCount`] ?? 0) + 1;
        if (status.status === 'IN_PROGRESS' && !timings.inProgressAt) timings.inProgressAt = Date.now();
        if (status.status === 'COMPLETED') break;
        if (status.status !== 'IN_QUEUE' && status.status !== 'IN_PROGRESS') throw new Error('queue-failed');
        await delay(signal);
      }
      mark(`${stage}.resultFetchStart`);
      const r = await fetchImpl(resultUrl, { headers: { Authorization: `Key ${key}` }, signal });
      if (!r.ok) throw new Error(`result-http-${r.status}`);
      const result = await r.json() as Json; mark(`${stage}.responseReceived`); return result;
    } finally {
      if (signal.aborted && task.cancel_url) void fetchImpl(safe(task.cancel_url), { method: 'PUT', headers: { Authorization: `Key ${key}` }, signal: AbortSignal.timeout(2000) }).catch(() => {});
    }
  };
  const runware = async (input: Json) => {
    const taskUUID = randomUUID();
    let result = await post('https://api.runware.ai/v1', [{ ...input, taskUUID, includeCost: true }], `Bearer ${key}`);
    while (true) {
      if (result.errors) throw new Error('runware-task-error');
      const item = (result.data as Json[] | undefined)?.find(x => x.taskUUID === taskUUID);
      if (item?.NSFWContent) throw new Error('provider-rejected');
      if (item?.imageURL || item?.videoURL) return item;
      signal.throwIfAborted(); await delay(signal);
      result = await post('https://api.runware.ai/v1', [{ taskType: 'getResponse', taskUUID }], `Bearer ${key}`);
    }
  };
  mark('inputPrepareStart');
  let image: string;
  if (config.mode !== 'reused-base-video') {
    reserve(.10); // Conservative image reservation; never use promotional rates.
    const result = config.provider === 'fal'
      ? await fal('fal-ai/flux-2/klein/4b', { prompt: CHICKEN_IMAGE_PROMPT, image_size: { width: 768, height: 768 }, num_images: 1, output_format: 'png' })
      : await runware({ taskType: 'imageInference', model: 'runware:400@4', positivePrompt: CHICKEN_IMAGE_PROMPT, width: 768, height: 768, numberResults: 1, outputFormat: 'PNG' });
    image = String(config.provider === 'fal' ? (result.images as Json[])?.[0]?.url : result.imageURL);
    timings.imageCompletedAt = Date.now();
  } else {
    const original = readFileSync('public/world/chicken-painted.png');
    const originalHash = createHash('sha256').update(original).digest('hex');
    const source = config.inputMode === 'hosted' && hostedSource?.hash === originalHash ? hostedSource.bytes : await sharp(original).resize(768, 768, { fit: 'contain', background: { r: 0, g: 255, b: 0, alpha: 1 } }).flatten({ background: { r: 0, g: 255, b: 0 } }).png().toBuffer();
    if (config.inputMode === 'hosted') hostedSource = { hash: originalHash, bytes: source };
    if (config.inputMode === 'hosted' && config.provider === 'fal') {
      const hash = createHash('sha256').update(source).digest('hex');
      const cachePath = `.world-experiments/manifestation/input-${hash}.json`;
      const cached = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, 'utf8')) as { url: string; expires: number } : null;
      if (cached && cached.expires > Date.now()) image = cached.url;
      else {
        mark('inputUploadStart');
        const task = await post('https://rest.fal.ai/storage/upload/initiate?storage_type=fal-cdn-v3', { content_type: 'image/png', file_name: `${hash}.png` }, `Key ${key}`);
        const upload = new URL(String(task.upload_url)), file = new URL(String(task.file_url));
        if (![upload, file].every(u => u.protocol === 'https:' && (u.hostname === 'fal.media' || u.hostname.endsWith('.fal.media')))) throw new Error('invalid-upload-host');
        const response = await fetchImpl(upload, { method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: new Uint8Array(source), signal, redirect: 'error' });
        if (!response.ok) throw new Error('input-upload-failed');
        image = file.href; mkdirSync('.world-experiments/manifestation', { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ url: image, expires: Date.now() + 3600_000 }));
        mark('inputUploadEnd');
      }
    } else image = `data:image/png;base64,${Buffer.from(source).toString('base64')}`;
  }
  mark('inputPrepareEnd');
  if (config.mode === 'fresh-image') {
    reserve(.05);
    const result = config.provider === 'fal'
      ? await fal('fal-ai/birefnet', { image_url: image, output_format: 'png' })
      : await runware({ taskType: 'imageBackgroundRemoval', model: 'runware:109@1', inputImage: image, outputFormat: 'PNG' });
    const url = String(config.provider === 'fal' ? (result.image as Json)?.url : result.imageURL);
    timings.maskCompletedAt = Date.now();
    return { url, kind: 'image', composite: 'alpha', mode: config.mode, timings, trace };
  }
  reserve(config.resolution === '480p' ? .125 : .20);
  const result = config.provider === 'fal'
    ? await fal('minimax/h3-max-turbo/image-to-video', { prompt: CHICKEN_VIDEO_PROMPT, image_url: image, duration: 5, resolution: config.resolution.toUpperCase(), prompt_expansion_mode: config.expansion ?? 'balanced', ...(config.seed === undefined ? {} : { seed: config.seed }), enable_safety_checker: true })
    : await runware({ taskType: 'videoInference', model: 'minimax:h3@max-turbo', positivePrompt: CHICKEN_VIDEO_PROMPT, inputs: { frameImages: [image] }, duration: 5, resolution: config.resolution, outputFormat: 'MP4', deliveryMethod: 'async', numberResults: 1 });
  timings.videoCompletedAt = Date.now(); mark('videoUrlAvailable');
  if (typeof (result.timings as Json)?.inference === 'number') timings.inferenceSeconds = (result.timings as Json).inference as number;
  trace.inferenceSeconds = timings.inferenceSeconds;
  if (trace.inferenceSeconds === undefined) trace.missing.push('inference not reported by provider');
  return { url: String(config.provider === 'fal' ? (result.video as Json)?.url : result.videoURL), kind: 'video', composite: 'green-key', mode: config.mode, timings, trace };
}
