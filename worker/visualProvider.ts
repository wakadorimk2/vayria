import { screenRectToImage, type WorldLayout } from '../src/world/worldLayout';
import type { VisualIntent } from '../src/visual/types';
export type VisualProvider = 'fal' | 'runware';
type Json = Record<string, unknown>;
export interface ProviderContext {
  provider: VisualProvider; falKey?: string; runwareKey?: string; signal: AbortSignal;
  reserve(step: string, cost: number): Promise<void>; timings: Record<string, number>; layout?: WorldLayout;
  fetcher?: typeof fetch;
}
const verifiedFalPrices = new Map<string, number>();
async function verifyFalPrice(c: ProviderContext, model: string, maximum: number, units:RegExp) {
  if ((verifiedFalPrices.get(model) ?? 0) > Date.now()) return;
  const response = await (c.fetcher ?? fetch)('https://api.fal.ai/v1/models/pricing?endpoint_id='+encodeURIComponent(model), {
    headers:{Authorization:'Key '+c.falKey}, signal:c.signal, redirect:'manual',
  });
  if(!response.ok)throw new Error('pricing_unavailable');
  const data=await response.json() as {prices?:{endpoint_id:string;unit_price:number;unit:string;currency:string}[]};
  const price=data.prices?.find(p=>p.endpoint_id===model);
  if(!price||!units.test(price.unit)||price.currency!=='USD'||!Number.isFinite(price.unit_price)||price.unit_price<0||price.unit_price>maximum)throw new Error('pricing_unverified');
  verifiedFalPrices.set(model,Date.now()+3600000);
}
async function verifyRunwarePrice(c:ProviderContext, stage:'image'|'mask'|'video') {
  if(stage==='video')throw new Error('unsupported_provider');
  const model=stage==='image'?'runware:400@4':'runware:109@1', cacheKey='runware:'+model;
  if((verifiedFalPrices.get(cacheKey)??0)>Date.now())return;
  const r=await (c.fetcher??fetch)('https://content.runware.ai/models/'+encodeURIComponent(model)+'/pricing',{signal:c.signal,redirect:'manual'});
  if(!r.ok)throw new Error('pricing_unavailable');
  const data=await r.json() as {air:string;pricingMeasured?:{price:number}[]};
  if(data.air!==model||!data.pricingMeasured?.length||!data.pricingMeasured.every(p=>Number.isFinite(p.price)&&p.price>0&&p.price<=(stage==='image'?.01:.05)))throw new Error('pricing_unverified');
  verifiedFalPrices.set(cacheKey,Date.now()+3600000);
}
const STYLE = 'Hand-painted anime fantasy illustration, clean readable silhouette, lavender cool bounce, warm soft upper-left light, restrained detail, no text, no watermark.';
export function visualPrompt(intent: VisualIntent, portrait: boolean, layout?: WorldLayout) {
  const subject = `${intent.concept}. ${intent.modifiers.join(', ')}.`;
  const quiet=layout?[layout.body,layout.face,...layout.obstacles].map(r=>screenRectToImage(r,layout,portrait?{width:768,height:1152}:{width:1152,height:768})).map(r=>Object.values(r).map(n=>Math.round(n*100)).join(',')).join(';'):'';
  return intent.type === 'background'
    ? `${STYLE} Environment only: ${subject} Keep these image regions quiet (x,y,width,height percentages after centered-cover cropping): ${quiet}. ${portrait ? 'Portrait' : 'Landscape'} scene. The central 55 percent is a quiet low-detail area behind an overlaid bust-up avatar. Put important objects at the left or right outer edges. Keep the bottom 25 percent low contrast for overlaid controls. No people, no avatar, no silhouette guide, no UI.`
    : `${STYLE} One isolated object: ${subject} Front three-quarter view, full object within frame, generous 18 percent empty margin on every side. Plain neutral background for removal, no floor or cast shadow. No hands or people.`;
}
export async function callVisualProvider(c: ProviderContext, stage: 'image'|'mask'|'video', input: Json) {
  const fetcher = c.fetcher ?? fetch, origin = performance.now();
  const mark = (key: string) => { c.timings[stage + '.' + key] = performance.now() - origin; };
  const read = async (url: string, body?: unknown) => {
    c.signal.throwIfAborted();
    const response = await fetcher(url, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: c.provider === 'fal' ? `Key ${c.falKey}` : `Bearer ${c.runwareKey}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body), signal: c.signal, redirect: 'manual' });
    c.timings[stage + '.http'] = response.status;
    if (!response.ok) throw new Error(`provider_http_${response.status}`);
    return response.json() as Promise<Json>;
  };
  // Verify the current rate before reserving or submitting a paid request.
  if (!(c.provider === 'fal' ? c.falKey : c.runwareKey)) throw new Error('provider_unconfigured');
  const model = stage === 'video' ? 'minimax/h3-max-turbo/image-to-video' : stage === 'mask' ? 'fal-ai/birefnet' : 'fal-ai/flux-2/klein/4b';
  if(c.provider==='fal')await verifyFalPrice(c,model,stage==='mask'?.0016:stage==='video'?.025:.005,stage==='image'?/^(megapixels?|MP)$/i:stage==='mask'?/^compute seconds?$/:/^(video )?seconds?$/);
  else await verifyRunwarePrice(c,stage);
  await c.reserve(stage, stage === 'video' ? 125000 : stage === 'mask' ? 50000 : 10000);
  c.timings[stage+'.requests']=(c.timings[stage+'.requests']??0)+1;
  mark('submit');
  if (c.provider === 'fal') {
    if (!c.falKey) throw new Error('provider_unconfigured');
    const task = await read('https://queue.fal.run/' + model, input); mark('accepted');
    const queueUrl = (v: unknown) => { const u = new URL(String(v)); if (u.origin !== 'https://queue.fal.run' || u.username || u.password) throw new Error('invalid_queue'); return u.href; };
    for (;;) {
      const status = await read(queueUrl(task.status_url));
      if (status.status === 'COMPLETED') break;
      if (!['IN_QUEUE','IN_PROGRESS'].includes(String(status.status))) throw new Error('provider_rejected');
      if (c.timings[stage + '.' + status.status] === undefined) mark(String(status.status));
      await new Promise(r => setTimeout(r, 150));
    }
    const result = await read(queueUrl(task.response_url)); mark('ready');
    if (Array.isArray(result.has_nsfw_concepts) && result.has_nsfw_concepts.some(Boolean)) throw new Error('provider_rejected');
    return result;
  }
  if (!c.runwareKey) throw new Error('provider_unconfigured');
  const taskUUID = crypto.randomUUID();
  let result = await read('https://api.runware.ai/v1', [{ ...input, taskUUID, includeCost: true }]);
  for (;;) {
    if (result.errors) throw new Error('provider_rejected');
    const item = (result.data as Json[] | undefined)?.find(x => x.taskUUID === taskUUID);
    if (item?.NSFWContent) throw new Error('provider_rejected');
    if (item?.imageURL || item?.videoURL) { mark('ready'); return item; }
    await new Promise(r => setTimeout(r, 150));
    result = await read('https://api.runware.ai/v1', [{ taskType: 'getResponse', taskUUID }]);
  }
}
export async function generateVisualImage(c: ProviderContext, intent: VisualIntent, portrait: boolean) {
  const size = intent.type === 'background' ? (portrait ? { width: 768, height: 1152 } : { width: 1152, height: 768 }) : { width: 768, height: 768 };
  const prompt = visualPrompt(intent, portrait, c.layout);
  const image = await callVisualProvider(c, 'image', c.provider === 'fal'
    ? { prompt, image_size: size, num_images: 1, output_format: 'png', enable_safety_checker: true }
    : { taskType: 'imageInference', model: 'runware:400@4', positivePrompt: prompt, ...size, numberResults: 1, outputFormat: 'PNG', checkNSFW: true });
  let url = String(c.provider === 'fal' ? (image.images as Json[])?.[0]?.url : image.imageURL);
  if (intent.type === 'prop') {
    const mask = await callVisualProvider(c, 'mask', c.provider === 'fal' ? { image_url: url, output_format: 'png' }
      : { taskType: 'removeBackground', model: 'runware:109@1', inputs:{image:url}, settings:{returnOnlyMask:false,rgba:[255,255,255,0]}, outputFormat: 'PNG' });
    url = String(c.provider === 'fal' ? (mask.image as Json)?.url : mask.imageURL);
  }
  return url;
}
export function safeVisualMediaUrl(value: string) {
  const u = new URL(value);
  if (u.protocol !== 'https:' || u.username || u.password || u.port ||
      !(u.hostname === 'fal.media' || u.hostname.endsWith('.fal.media') || u.hostname === 'im.runware.ai')) throw new Error('invalid_media');
  return u.href;
}
