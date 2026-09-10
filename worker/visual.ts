import { isWorldLayout } from '../src/world/worldLayout';
import { VISUAL_EFFECTS, readVisualIntent, cacheDecision, assetDescriptionKey, type VisualIntent, type VisualAsset } from '../src/visual/types';
import { sign, verify, boundedBody } from './security';
import { LimitError } from './ledger';
import { generateVisualImage, callVisualProvider, safeVisualMediaUrl, type ProviderContext, type VisualProvider } from './visualProvider';
import { inspectVisualPng } from './visualMedia';
export interface VisualEnv {
  ASSETS: Fetcher; VISUAL_ASSETS?: R2Bucket; COOKIE_SECRET: string; MANIFESTATION_ENABLED?: string;
  PUBLIC_BASE_PATH?: string; GENERATION_ENABLED: string; FAL_KEY?: string; RUNWARE_API_KEY?: string;
  VISUAL_IMAGE_PROVIDER?: string; VISUAL_BACKGROUND_ENABLED?: string; VISUAL_VIDEO_ENABLED?: string;
}
export type VisualLedger = <T>(op: string, args?: object) => Promise<T>;
interface VisualTicket { exp: number; purpose: string; visitor: string; session: string; generation: number; token: string; intent: VisualIntent; video: boolean }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const stock: Record<string,string> = { chicken:'chicken-1', '鶏':'chicken-1', egg:'egg', '卵':'egg', feather:'feather', '羽根':'feather', bat:'bat', 'バット':'bat' };
export async function visualTicket(response: { visualIntent?: unknown }, env: VisualEnv, visitor: string, session: string, generation: number, video: boolean) {
  const intent = readVisualIntent(response.visualIntent); if (!intent || intent.type === 'none') return { ...response, visualIntent: undefined };
  if (!video) { intent.motion = ''; intent.motionEvidence = ''; }
  const token = crypto.randomUUID();
  if (intent.type === 'background') intent.targetId = 'background';
  else if ((intent.type === 'prop' && intent.action === 'add') || !intent.targetId) intent.targetId = token;
  const ticket = await sign({ purpose:'visual', visitor, session, generation, token, intent, video, exp: Date.now()+90000 }, env.COOKIE_SECRET);
  return { ...response, visualIntent: intent, visualTicket: ticket, visualGeneration: generation };
}
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
export function sharedVisual(intent: VisualIntent) {
  // Generalization is deliberately conservative: uncertain or personal descriptions never become shared metadata.
  const subjects = /^(chicken|egg|feather|bat|moon|crab|pudding|crystal crab|sea|underwater|space|spaceship|supermarket fish counter|forest|beach|鶏|卵|羽根|バット|月|カニ|プリン|海|水中|宇宙|宇宙船|森|浜辺)$/i;
  const modifiers = /^(giant|small|transparent|crystal|red|blue|white|gold|wooden|round|sparkling|rain|snow|巨大|小さい|透明|水晶|赤|青|白|金色|雨|雪)$/i;
  return intent.sharing === 'general' && subjects.test(intent.concept) && intent.modifiers.every(m=>modifiers.test(m)||VISUAL_EFFECTS.includes(m as typeof VISUAL_EFFECTS[number]));
}
export async function visualRoute(request: Request, env: VisualEnv, visitor: string, session: string, ledger: VisualLedger) {
  if (env.MANIFESTATION_ENABLED !== 'true' || env.PUBLIC_BASE_PATH !== '/staging') throw new LimitError('not_found',0,404);
  const path = new URL(request.url).pathname, who = { visitor, id:session };
  if (path === '/api/visual/mode' && request.method === 'POST') {
    const b = JSON.parse(new TextDecoder().decode(await boundedBody(request,1024)));
    if (typeof b.enabled !== 'boolean' || !Number.isSafeInteger(b.generation)) throw new LimitError('invalid_request',0,400);
    return json(await ledger('visualMode',{...who,enabled:b.enabled,generation:b.generation}));
  }
  if (path.startsWith('/api/visual/media/') && request.method === 'GET') {
    const ticket = await verify<{exp:number;purpose:string;visitor:string;session:string;key:string}>(new URL(request.url).searchParams.get('ticket')??'',env.COOKIE_SECRET);
    if (!ticket || ticket.purpose!=='visual-media' || ticket.visitor!==visitor || ticket.key!==path.split('/').pop()) throw new LimitError('invalid_ticket',0,403);
    await ledger('visualPermission',{visitor,id:ticket.session}); // Existing displayed media remains readable after OFF.
    const range=request.headers.get('Range');
    if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))return new Response(null,{status:416});
    const asset=await env.VISUAL_ASSETS?.get(ticket.key,{range:request.headers});
    if(!asset)throw new LimitError('not_found',0,404);
    const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'});asset.writeHttpMetadata(headers);
    if(asset.range && 'offset' in asset.range && 'length' in asset.range){headers.set('Content-Range',`bytes ${asset.range.offset}-${asset.range.offset!+asset.range.length!-1}/${asset.size}`);return new Response(asset.body,{status:206,headers});}
    return new Response(asset.body,{headers});
  }
  if(!['/api/visual/generate','/api/visual/cancel'].includes(path)||request.method!=='POST')throw new LimitError('not_found',0,404);
  const b=JSON.parse(new TextDecoder().decode(await boundedBody(request,14000)));
  const ticket=await verify<VisualTicket>(String(b.ticket??''),env.COOKIE_SECRET);
  if(!ticket||ticket.purpose!=='visual'||ticket.visitor!==visitor||ticket.session!==session)throw new LimitError('invalid_ticket',0,403);
  const permission=await ledger<{enabled:boolean;generation:number}>('visualPermission',who);
  if(!permission.enabled||permission.generation!==ticket.generation)throw new LimitError('visual_disabled',0,409);
  const intent=readVisualIntent(ticket.intent);if(!intent||intent.type==='none')throw new LimitError('invalid_request',0,400);
  const args={...who,generation:ticket.generation,token:ticket.token};
  if(path==='/api/visual/cancel'||intent.action==='cancel'){await ledger('visualCancel',{...args,token:intent.action==='cancel'?undefined:ticket.token,target:intent.targetId});return json({type:'cancel',targetId:intent.targetId});}
  if(intent.type==='effect')return json({type:'effect',intent});
  intent.modifiers=intent.modifiers.filter(m=>!VISUAL_EFFECTS.includes(m as typeof VISUAL_EFFECTS[number]));
  const portrait=b.portrait===true, scope=sharedVisual(intent)?'shared':session;
  const key=await digest(scope+assetDescriptionKey(intent,portrait));
  const cached=await ledger<VisualAsset|null>('visualLookup',{...args,key});
  const resolve=async(asset:VisualAsset)=>{
    if(asset.url.startsWith('/manifestation/'))return {...asset,url:'/staging'+asset.url};
    const signed=await sign({purpose:'visual-media',visitor,session,key:asset.id,exp:Math.min(asset.expiresAt,Date.now()+900000)},env.COOKIE_SECRET);
    return {...asset,url:'/staging/api/visual/media/'+asset.id+'?ticket='+encodeURIComponent(signed)};
  };
  const builtin=stock[intent.concept.toLowerCase()];
  if(intent.type==='prop'&&!cached&&builtin&&!intent.modifiers.length&&!ticket.video){
    return json({type:'asset',asset:{id:ticket.token,url:'/staging/manifestation/'+builtin+'.png',kind:'image',composite:'alpha',type:'prop',concept:intent.concept,createdAt:0,expiresAt:Number.MAX_SAFE_INTEGER,scope:'shared'}});
  }
  const decision=cacheDecision(cached,Date.now(),intent.regenerate);
  if(cached&&decision==='reuse')return json({type:'asset',asset:await resolve(cached)});
  if(intent.type==='background'&&env.VISUAL_BACKGROUND_ENABLED!=='true')return json({type:'failed',code:'background_not_adopted'});
  if(!env.VISUAL_ASSETS)throw new LimitError('storage_unconfigured',0,503);
  const duration=Math.min(intent.type==='background'?60000:30000,Number.isFinite(b.remainingMs)&&b.remainingMs>0?b.remainingMs:Number.MAX_SAFE_INTEGER);
  const claim=await ledger<{owner:boolean}>('visualStart',{...args,key,target:intent.targetId,duration});
  let disconnected=false;
  const abort=new AbortController(); const signal=AbortSignal.any([request.signal,abort.signal,AbortSignal.timeout(duration)]);
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller){
      const timings:Record<string,number>={};const start=performance.now();let code='failed';
      const emit=(value:object)=>{if(!disconnected)controller.enqueue(new TextEncoder().encode(JSON.stringify(value)+'\n'));};
      try {
        if(cached)emit({type:'asset',asset:await resolve(cached)});
        if(!claim.owner){
          while(!signal.aborted){await new Promise(r=>setTimeout(r,200));const asset=await ledger<VisualAsset|null>('visualLookup',{...args,key});if(asset&&asset.createdAt>(cached?.createdAt??0)){emit({type:'asset',asset:await resolve(asset)});code='shared_cache';return;}}
          signal.throwIfAborted();
        }
        const provider:VisualProvider=env.VISUAL_IMAGE_PROVIDER==='runware'?'runware':'fal';
        const context:ProviderContext={provider,falKey:env.FAL_KEY,runwareKey:env.RUNWARE_API_KEY,signal,timings,layout:isWorldLayout(b.layout)?b.layout:undefined,
          reserve:async(step,cost)=>{if(env.GENERATION_ENABLED!=='true')throw new Error('generation_stopped');await ledger('visualReserve',{...args,step,cost});}};
        let url:string;
        if(ticket.video&&env.VISUAL_VIDEO_ENABLED==='true'&&builtin==='chicken-1'&&!intent.modifiers.length){
          emit({type:'asset',asset:{id:ticket.token,url:'/staging/manifestation/chicken-1.png',kind:'image',composite:'alpha',type:'prop',concept:intent.concept,createdAt:0,expiresAt:Number.MAX_SAFE_INTEGER,scope:'shared'}});
          const source=await env.ASSETS.fetch(new Request('https://assets/manifestation/chicken-source.png'));
          if(!source.ok||!source.headers.get('Content-Type')?.includes('image/png'))throw new Error('source_invalid');
          const result=await callVisualProvider({...context,provider:'fal'},'video',{image_url:'data:image/png;base64,'+Buffer.from(await source.arrayBuffer()).toString('base64'),prompt:`Locked camera. One chicken ${intent.motion}. Full silhouette inside frame. Uniform green background. No cuts, hands, text, or other subjects.`,duration:5,resolution:'480P',prompt_expansion_mode:'fast',enable_safety_checker:true});
          url=String((result.video as {url?:string})?.url);
        }else url=await generateVisualImage(context,intent,portrait);
        const media=await fetch(safeVisualMediaUrl(url),{signal,redirect:'error'});
        if(!media.ok)throw new Error('media_failed');
        const video=ticket.video&&env.VISUAL_VIDEO_ENABLED==='true'&&builtin==='chicken-1'&&!intent.modifiers.length;
        if(!media.headers.get('Content-Type')?.includes(video?'video/mp4':'image/png'))throw new Error('media_type');
        const bytes=await boundedBody(media as unknown as Request,video?32000000:12000000);
        if(!video)await inspectVisualPng(new Uint8Array(bytes),intent.type==='prop');
        const now=Date.now(), id=(scope==='shared'?'s-':'p-')+await digest(key+now+ticket.token), expiresAt=now+(scope==='shared'?30:1)*86400000;
        await ledger('visualPermission',who).then(p=>{const value=p as {enabled:boolean;generation:number};if(!value.enabled||value.generation!==ticket.generation)throw new Error('visual_disabled');});
        await env.VISUAL_ASSETS!.put(id,bytes,{httpMetadata:{contentType:video?'video/mp4':'image/png'},customMetadata:{expiresAt:String(expiresAt),scope:scope==='shared'?'shared':'private'}});
        const asset:VisualAsset={id,url:id,kind:video?'video':'image',composite:video?'green-key':intent.type==='prop'?'alpha':'opaque',type:intent.type as 'prop'|'background',concept:intent.concept,createdAt:now,expiresAt,scope};
        await ledger('visualPublish',{...args,asset});timings.ready=performance.now()-start;
        emit({type:'asset',asset:await resolve(asset)});code='complete';
      }catch(error){code=error instanceof Error?/^[\w-]{1,60}$/.test(error.message)?error.message:'visual_failed':'visual_failed';emit({type:'failed',code});}
      finally{timings.total=performance.now()-start;await ledger('visualFinish',{...args,code,timings}).catch(()=>{});if(!disconnected)controller.close();}
    },cancel(){disconnected=true;abort.abort();}
  }),{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
}
