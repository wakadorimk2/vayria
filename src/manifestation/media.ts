import { playVideo, waitVideoEvent } from './videoPlayback.js';
import type { GeneratedObject } from './types.js';
export const videoInspectionVersions=new Map<string,number>();
export const preparedVideos = new Map<string, HTMLVideoElement>();
/** Key only the saturated green screen. White plumage and yellow feet remain opaque. */
export function keyGreen(data: Uint8ClampedArray, keyColor: 'green' | 'blue' = 'green') {
  for (let i = 0; i < data.length; i += 4) {
    const k = keyColor === 'green' ? 1 : 2, other = k === 1 ? 2 : 1;
    const r = data[i], g = data[i + k], b = data[i + other];
    const excess = g - Math.max(r, b);
    const alpha = Math.max(0, Math.min(1, (65 - excess) / 45));
    if (g > 80 && excess > 20) { data[i + 3] = Math.round(255 * alpha); data[i + k] = Math.min(g, Math.max(r, b) + 20); }
  }
}
export async function prepareObject(media: GeneratedObject, signal: AbortSignal) {
  const origin = media.trace ? (media.trace.browserOrigin ??= performance.now()) : performance.now();
  const mark = (name: string) => { if (media.trace) media.trace.browser[name] = performance.now() - origin; };
  mark('mediaPrepareStart');
  if (!/^(?:\/staging)?\/api\/visual\/media\/[sp]-[a-f0-9]+\?ticket=[A-Za-z0-9_.%-]+$/.test(media.url) && !/^(?:\/staging)?\/api\/manifestation\/(?:assets\/[a-f0-9]{64}\.(mp4|png)|media\/[\w-]{36}(?:\?(?:buffered=1|replay=[\w-]{36})(?:&buffered=1)?)?)$/.test(media.url)) throw new Error('invalid-local-media');
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
    video.addEventListener('loadedmetadata',()=>media.onMediaStage?.('metadata'),{once:true});
    mark('mediaRequestStart');video.src=media.url;
    // iOS may preload metadata only. Start muted decoding before waiting for a frame.
    media.onMediaStage?.('play_requested');
    await playVideo(video,signal);media.onMediaStage?.('play_started');
    if(video.readyState<2)await waitVideoEvent(video,'loadeddata',signal,10000,'video_loading_timeout');
    signal.throwIfAborted();media.onMediaStage?.('loaded_data');
    inspectVideoFrame(video,media.keyColor);
    media.onMediaStage?.('key_passed');
    preparedVideos.set(media.url, video);
    media.timings.compositeReadyAt = Date.now();
  } catch (error) { abort(); throw error; }
  finally { signal.removeEventListener('abort', abort); }
}
export function releasePrepared(url: string) {
  const video = preparedVideos.get(url);
  if (video) { video.pause(); video.removeAttribute('src'); video.load(); preparedVideos.delete(url); }
}

export function inspectVideoFrame(video:HTMLVideoElement,keyColor:'green'|'blue'='green') {
  if(!video.videoWidth||!video.videoHeight)throw new Error('video_load_failed');
  const canvas=document.createElement('canvas');canvas.width=128;canvas.height=128;
  const context=canvas.getContext('2d',{willReadFrequently:true});if(!context)throw new Error('canvas-unavailable');
  context.drawImage(video,0,0,128,128);const pixels=context.getImageData(0,0,128,128);keyGreen(pixels.data,keyColor);
  let clear=0,solid=0,edge=0;
  for(let p=0;p<128*128;p++){const a=pixels.data[p*4+3];if(a<16)clear++;if(a>240)solid++;if((p<128||p>=127*128||p%128===0||p%128===127)&&a>50)edge++;}
  if(clear<128*128*.25||solid<128*128*.03||edge>25)throw new Error('key_quality');
}
