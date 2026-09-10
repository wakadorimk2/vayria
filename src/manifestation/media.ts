import type { GeneratedObject } from './types.js';
export const preparedVideos = new Map<string, HTMLVideoElement>();
/** Key only the saturated green screen. White plumage and yellow feet remain opaque. */
export function keyGreen(data: Uint8ClampedArray) {
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const excess = g - Math.max(r, b);
    const alpha = Math.max(0, Math.min(1, (65 - excess) / 45));
    if (g > 80 && excess > 20) { data[i + 3] = Math.round(255 * alpha); data[i + 1] = Math.min(g, Math.max(r, b) + 20); }
  }
}
export async function prepareObject(media: GeneratedObject, signal: AbortSignal) {
  const origin = media.trace ? (media.trace.browserOrigin ??= performance.now()) : performance.now();
  const mark = (name: string) => { if (media.trace) media.trace.browser[name] = performance.now() - origin; };
  mark('mediaPrepareStart');
  if (!/^(?:\/staging)?\/api\/manifestation\/(?:assets\/[a-f0-9]{64}\.(mp4|png)|media\/[\w-]{36}(?:\?(?:buffered=1|replay=[\w-]{36})(?:&buffered=1)?)?)$/.test(media.url)) throw new Error('invalid-local-media');
  if (media.kind === 'image') {
    const img = new Image(); img.src = media.url; await img.decode(); signal.throwIfAborted(); return;
  }
  const video = document.createElement('video');
  video.addEventListener('loadedmetadata', () => mark('loadedmetadata'), { once: true });
  video.addEventListener('canplay', () => mark('canplay'), { once: true });
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.loop = true;
  const abort = () => { video.pause(); video.removeAttribute('src'); video.load(); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => reject(new Error('aborted'));
      const clean = () => signal.removeEventListener('abort', stop);
      video.onloadeddata = () => { mark('loadeddata'); clean(); resolve(); };
      video.onerror = () => { clean(); reject(new Error('video-decode')); };
      if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
      mark('mediaRequestStart'); video.src = media.url;
    });
    signal.throwIfAborted();
    const canvas = document.createElement('canvas'); canvas.width = 128; canvas.height = 128;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('canvas-unavailable');
    context.drawImage(video, 0, 0, 128, 128);
    const pixels = context.getImageData(0, 0, 128, 128); keyGreen(pixels.data);
    mark('firstKeyCompleted');
    let clear = 0, solid = 0, edge = 0;
    for (let p = 0; p < 128 * 128; p++) {
      const a = pixels.data[p * 4 + 3];
      if (a < 16) clear++; if (a > 240) solid++;
      if ((p < 128 || p >= 127 * 128 || p % 128 === 0 || p % 128 === 127) && a > 50) edge++;
    }
    if (clear < 128 * 128 * .25 || solid < 128 * 128 * .03 || edge > 25) throw new Error('key-quality');
    signal.throwIfAborted();
    preparedVideos.set(media.url, video);
    media.timings.compositeReadyAt = Date.now();
  } catch (error) { abort(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
export function releasePrepared(url: string) {
  const video = preparedVideos.get(url);
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); preparedVideos.delete(url); }
}
