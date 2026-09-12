import { isWorldLayout } from '../src/world/worldLayout';
import { VISUAL_EFFECTS, normalizeVisualIntent, legacyVisualIntents, legacyAssetDescriptionKey, readVisualIntent, cacheDecision, assetDescriptionKey, type VisualIntent, type VisualAsset } from '../src/visual/types';
import { sign, verify, boundedBody } from './security';
import { LimitError } from './ledger';
import { generateVisualImage, callVisualProvider, safeVisualMediaUrl, type ProviderContext, type VisualProvider } from './visualProvider';
import { inspectVisualPng, videoSourcePng } from './visualMedia';
export interface VisualEnv {
  ASSETS: Fetcher; VISUAL_ASSETS?: R2Bucket; COOKIE_SECRET: string; MANIFESTATION_ENABLED?: string;
  PUBLIC_BASE_PATH?: string; GENERATION_ENABLED: string; FAL_KEY?: string; RUNWARE_API_KEY?: string;
  VISUAL_IMAGE_PROVIDER?: string; VISUAL_BACKGROUND_ENABLED?: string; VISUAL_VIDEO_ENABLED?: string;
}
export type VisualLedger = <T>(op: string, args?: object) => Promise<T>;
interface VisualTicket { eventId?:string; exp: number; purpose: string; visitor: string; session: string; generation: number; token: string; intent: VisualIntent; video: boolean }
const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
const stock: Record<string,string> = { chicken:'chicken-1', '鶏':'chicken-1', egg:'egg', '卵':'egg', feather:'feather', '羽根':'feather', bat:'bat', 'バット':'bat' };
export async function visualTicket(response: { visualIntent?: unknown }, env: VisualEnv, visitor: string, session: string, generation: number, video: boolean, eventId?:string) {
  const intent = readVisualIntent(response.visualIntent); if (!intent || intent.type === 'none') return { ...response, visualIntent: undefined };
  const normalized=normalizeVisualIntent(intent);if(!normalized.motion&&intent.motion){intent.modifiers=normalized.modifiers;video=false;}
  if (!video) { intent.motion = ''; intent.motionEvidence = ''; }
  const token = crypto.randomUUID();
  if (intent.type === 'background') intent.targetId = 'background';
  else if ((intent.type === 'prop' && intent.action === 'add') || !intent.targetId) intent.targetId = token;
  const ticket = await sign({ eventId: eventId&&/^[\w-]{1,80}$/.test(eventId)?eventId:token, purpose:'visual', visitor, session, generation, token, intent, video, exp: Date.now()+90000 }, env.COOKIE_SECRET);
  return { ...response, visualIntent: intent, visualTicket: ticket, visualGeneration: generation };
}
async function digest(value: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map(b=>b.toString(16).padStart(2,'0')).join(''); }
export function sharedVisual(intent: VisualIntent) {
  // Generalization is deliberately conservative: uncertain or personal descriptions never become shared metadata.
  const subjects = /^(chicken|egg|feather|bat|moon|crab|pudding|crystal crab|sea|underwater|space|spaceship|supermarket fish counter|forest|beach|鶏|卵|羽根|バット|月|カニ|プリン|海|水中|宇宙|宇宙船|森|浜辺)$/i;
  const modifiers = /^(giant|small|transparent|crystal|red|blue|white|gold|wooden|round|sparkling|rain|snow|巨大|小さい|透明|水晶|赤|青|白|金色|雨|雪)$/i;
  return intent.sharing === 'general' && subjects.test(intent.concept) && intent.modifiers.every(m=>modifiers.test(m)||VISUAL_EFFECTS.includes(m as typeof VISUAL_EFFECTS[number]));
}
export async function visualRoute(request: Request, env: VisualEnv, visitor: string, session: string, ledger: VisualLedger, ctx?: ExecutionContext) {
  const base=env.PUBLIC_BASE_PATH??'';
  if (env.MANIFESTATION_ENABLED !== 'true' || !['','/staging'].includes(base)) throw new LimitError('not_found',0,404);
  const path = new URL(request.url).pathname, who = { visitor, id:session };
  if (path === '/api/visual/mode' && request.method === 'POST') {
    const b = JSON.parse(new TextDecoder().decode(await boundedBody(request,1024)));
    if (typeof b.enabled !== 'boolean' || !Number.isSafeInteger(b.generation)) throw new LimitError('invalid_request',0,400);
    return json(await ledger('visualMode',{...who,enabled:b.enabled,generation:b.generation}));
  }
  if(path==='/api/visual/replay'&&request.method==='POST'){
    const b=JSON.parse(new TextDecoder().decode(await boundedBody(request,1024)));
    if(typeof b.assetId!=='string'||!/^([sp]-)[a-f0-9]{64}$/.test(b.assetId)||!Number.isSafeInteger(b.generation))throw new LimitError('invalid_request',0,400);
    const asset=await ledger<VisualAsset|null>('visualReplay',{...who,key:b.assetId,generation:b.generation});
    if(!asset)throw new LimitError('not_found',0,404);
    const resolveReplay=async(a:VisualAsset):Promise<VisualAsset>=>{
      if(a.url.startsWith('/manifestation/'))return {...a,url:base+a.url};
      const ticket=await sign({purpose:'visual-media',visitor,session,key:a.id,exp:Math.min(a.expiresAt,Date.now()+900000)},env.COOKIE_SECRET);
      return {...a,url:base+'/api/visual/media/'+a.id+'?ticket='+encodeURIComponent(ticket),source:a.source?await resolveReplay(a.source):undefined};
    };
    return json({type:'asset',asset:await resolveReplay(asset),cache:true});
  }
  if (path.startsWith('/api/visual/media/') && request.method === 'GET') {
    const ticket = await verify<{exp:number;purpose:string;visitor:string;session:string;key:string}>(new URL(request.url).searchParams.get('ticket')??'',env.COOKIE_SECRET);
    if (!ticket || ticket.purpose!=='visual-media' || ticket.visitor!==visitor || ticket.key!==path.split('/').pop()) throw new LimitError('invalid_ticket',0,403);
    await ledger('visualPermission',{visitor,id:ticket.session}); // Existing displayed media remains readable after OFF.
    const range=request.headers.get('Range');
    if(range&&!/^bytes=(?:\d+-\d*|-\d+)$/.test(range))return new Response(null,{status:416});
    const head=range&&env.VISUAL_ASSETS?.head?await env.VISUAL_ASSETS.head(ticket.key):null;
    if(head&&range){const match=/^bytes=(\d*)-(\d*)$/.exec(range)!;const start=match[1]?Number(match[1]):Math.max(0,head.size-Number(match[2]));const end=match[1]&&match[2]?Number(match[2]):head.size-1;
      if(start>=head.size||end<start||(!match[1]&&Number(match[2])===0))return new Response(null,{status:416,headers:{'Content-Range':`bytes */${head.size}`,'Content-Length':'0'}});}
    const asset=await env.VISUAL_ASSETS?.get(ticket.key,{range:request.headers});
    if(!asset){
      const ref=await ledger<{url:string}|null>('visualMediaLookup',{visitor,id:ticket.session,key:ticket.key});
      if(!ref)throw new LimitError('not_found',0,404);
      const upstream=await fetch(safeVisualMediaUrl(ref.url),{headers:range?{Range:range}:{},redirect:'manual',signal:request.signal});
      if(![200,206,416].includes(upstream.status))throw new LimitError('media_failed',0,502);
      const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes'});
      for(const name of ['Content-Type','Content-Length','Content-Range']){const value=upstream.headers.get(name);if(value)headers.set(name,value);}
      return new Response(upstream.body,{status:upstream.status,headers});
    }
    const headers=new Headers({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff','Accept-Ranges':'bytes','Content-Length':String(asset.size)});asset.writeHttpMetadata(headers);
    if(asset.range && 'offset' in asset.range && 'length' in asset.range){headers.set('Content-Length',String(asset.range.length));headers.set('Content-Range',`bytes ${asset.range.offset}-${asset.range.offset!+asset.range.length!-1}/${asset.size}`);return new Response(asset.body,{status:206,headers});}
    return new Response(asset.body,{headers});
  }
  if(!['/api/visual/generate','/api/visual/cancel','/api/visual/diagnostic'].includes(path)||request.method!=='POST')throw new LimitError('not_found',0,404);
  const b=JSON.parse(new TextDecoder().decode(await boundedBody(request,14000)));
  const ticket=await verify<VisualTicket>(String(b.ticket??''),env.COOKIE_SECRET);
  if(!ticket||ticket.purpose!=='visual'||ticket.visitor!==visitor||ticket.session!==session)throw new LimitError('invalid_ticket',0,403);
  const permission=await ledger<{enabled:boolean;generation:number}>('visualPermission',who);
  if(!permission.enabled||permission.generation!==ticket.generation)throw new LimitError('visual_disabled',0,409);
  if(path==='/api/visual/diagnostic')return json(await ledger('visualDiagnostic',{...who,generation:ticket.generation,eventId:ticket.eventId??ticket.token,records:b.records}));
  const rawIntent=readVisualIntent(ticket.intent);const intent=rawIntent&&normalizeVisualIntent(rawIntent);if(!intent||intent.type==='none')throw new LimitError('invalid_request',0,400);
  const args={...who,generation:ticket.generation,token:ticket.token};
  if(path==='/api/visual/cancel'||intent.action==='cancel'){await ledger('visualCancel',{...args,token:intent.action==='cancel'?undefined:ticket.token,target:intent.targetId});return json({type:'cancel',targetId:intent.targetId});}
  if(ticket.video && env.VISUAL_VIDEO_ENABLED!=='true')return json({type:'failed',code:'video_disabled'});
  if(intent.type==='effect')return json({type:'effect',intent});
  intent.modifiers=intent.modifiers.filter(m=>!VISUAL_EFFECTS.includes(m as typeof VISUAL_EFFECTS[number]));
  const lookupStarted=performance.now(),portrait=b.portrait===true;
  let scope=sharedVisual(intent)?'shared':session,source:VisualAsset|null=null;
  const builtin=stock[intent.concept.toLowerCase()];
  const stockSource=():VisualAsset=>({id:'stock-'+builtin,url:'/manifestation/'+builtin+'.png',kind:'image',composite:'alpha',type:'prop',concept:intent.concept,createdAt:0,expiresAt:Number.MAX_SAFE_INTEGER,scope:'shared'});
  if(ticket.video&&b.source&&intent.action==='replace'){
    const candidate=b.source.source??b.source;
    if(typeof candidate.url!=='string')throw new LimitError('invalid_source',0,400);
    if(candidate.url.startsWith(base+'/api/visual/media/')){
      const u=new URL(candidate.url,'https://local');
      const proof=await verify<{exp:number;purpose:string;visitor:string;session:string;key:string}>(u.searchParams.get('ticket')??'',env.COOKIE_SECRET);
      if(!proof||proof.purpose!=='visual-media'||proof.visitor!==visitor||proof.session!==session||proof.key!==u.pathname.split('/').pop())throw new LimitError('invalid_source',0,403);
      source=await ledger<VisualAsset|null>('visualReplay',{...args,key:proof.key});
      if(!source||source.kind!=='image')throw new LimitError('invalid_source',0,403);
    }else if(builtin&&candidate.url===base+'/manifestation/'+builtin+'.png')source=stockSource();
    else throw new LimitError('invalid_source',0,403);
    if(source.scope!=='shared')scope=session;
  }
  const baseIntent={...intent,motion:'',motionEvidence:''};
  const baseKey=await digest(scope+assetDescriptionKey(baseIntent,portrait));
  const legacyKeys=async(video:boolean)=>[...new Set(await Promise.all(legacyVisualIntents({...rawIntent!,...(video?{}:{motion:'',motionEvidence:''})}).flatMap(i=>video
    ? [source?.id,'new'].filter((v):v is string=>!!v).map(id=>digest(scope+legacyAssetDescriptionKey(i,portrait)+':video-v2:'+id))
    : [digest(scope+legacyAssetDescriptionKey(i,portrait))])))].slice(0,80);
  const lookup=(key:string)=>ledger<VisualAsset|null>('visualLookup',{...args,key});
  const findBase=async()=>{
    const direct=await lookup(baseKey);if(direct)return direct;
    const old=await ledger<{key:string;asset:VisualAsset}|null>('visualLookupAny',{...args,keys:await legacyKeys(false)});
    if(!old||old.asset.kind!=='image')return null;
    return ledger<VisualAsset>('visualAlias',{...args,key:baseKey,fromKey:old.key});
  };
  // A displayed source can only shortcut preparation for the same appearance.
  if(source&&(normalizeVisualIntent({...baseIntent,concept:source.concept}).concept!==intent.concept||intent.modifiers.length)){
    const matching=await findBase();source=matching?.kind==='image'?matching:null;
  }
  source??=await findBase();
  if(!source&&builtin&&!intent.modifiers.length)source=stockSource();
  const videoKey=()=>digest(scope+assetDescriptionKey(intent,portrait)+':video-v3:h3-480-fast:key-v1:'+source!.id);
  let key=ticket.video&&source?await videoKey():baseKey;
  let cached=ticket.video?(source?await lookup(key):null):source;
  if(ticket.video&&!cached){
    const old=await ledger<{key:string;asset:VisualAsset}|null>('visualLookupAny',{...args,keys:await legacyKeys(true)});
    if(old?.asset.kind==='video'&&old.asset.source&&(!source||source.id===old.asset.source.id)){
      source??=old.asset.source;key=await videoKey();cached=await ledger<VisualAsset>('visualAlias',{...args,key,fromKey:old.key});
    }
  }
  const resolve=async(asset:VisualAsset):Promise<VisualAsset>=>{
    if(asset.url.startsWith('/manifestation/'))return {...asset,url:base+asset.url};
    const signed=await sign({purpose:'visual-media',visitor,session,key:asset.id,exp:Math.min(asset.expiresAt,Date.now()+900000)},env.COOKIE_SECRET);
    return {...asset,url:base+'/api/visual/media/'+asset.id+'?ticket='+encodeURIComponent(signed),...(asset.source?{source:await resolve(asset.source)}:{})};
  };
  const timings:Record<string,number>={cacheLookup:performance.now()-lookupStarted,cacheHit:cached?1:0,cacheMiss:cached?0:1,explicitRefresh:intent.regenerate?1:0,...(!cached?{[source?'cacheMiss.variant':'cacheMiss.source']:1}:{})};
  if((cached&&cacheDecision(cached,Date.now(),intent.regenerate)==='reuse')||b.cacheOnly===true){
    // Cache-only never claims, reserves, or submits a provider request.
    const record=ledger('visualFinish',{...args,code:cached?'cache_reuse':'cache_miss',timings,eventId:ticket.eventId}).catch(()=>{});
    if(ctx)ctx.waitUntil(record);else await record;
    return cached?json({type:'asset',asset:await resolve(cached),cache:true,timings}):json({type:'failed',code:'cache_miss',timings});
  }
  if(intent.type==='background'&&env.VISUAL_BACKGROUND_ENABLED!=='true')return json({type:'failed',code:'background_not_adopted'});
  if(!env.VISUAL_ASSETS)throw new LimitError('storage_unconfigured',0,503);
  const duration=Math.min(intent.type==='background'?60000:30000,Number.isFinite(b.remainingMs)&&b.remainingMs>0?b.remainingMs:Number.MAX_SAFE_INTEGER);
  // A request owns its cancellation lifetime; shared stage claims own preparation.
  await ledger('visualStart',{...args,key:'request:'+ticket.token,target:intent.targetId,duration});
  let disconnected=false;
  const abort=new AbortController(),signal=AbortSignal.any([request.signal,abort.signal,AbortSignal.timeout(duration)]);
  return new Response(new ReadableStream<Uint8Array>({
    async start(controller){
      const start=performance.now();let code='failed';
      const emit=(value:object)=>{if(!disconnected)controller.enqueue(new TextEncoder().encode(JSON.stringify(value)+'\n'));};
      const share=async<T extends {id:string}>(stage:string,stageKey:string,get:()=>Promise<T|null>,create:()=>Promise<T>,previous?:string):Promise<T>=>{
        const usable=(v:T|null)=>v&&v.id!==previous;
        let value=await get();if(usable(value)){timings[stage+'.cacheHit']=1;return value!;}
        const claim=await ledger<{owner:boolean;token:string}>('visualClaim',{...args,key:stageKey});
        if(claim.owner){value=await get();if(usable(value)){timings[stage+'.cacheHit']=1;return value!;}return create();}
        timings[stage+'.joined']=1;
        while(!signal.aborted){
          value=await get();if(usable(value))return value!;
          if(!await ledger<boolean>('visualClaimActive',{...args,key:stageKey,token:claim.token}))throw new Error('shared_preparation_failed');
          await new Promise(r=>setTimeout(r,100));
        }
        signal.throwIfAborted();throw new Error('aborted');
      };
      try{
        if(cached)emit({type:'asset',asset:await resolve(cached),cache:true});
        const provider:VisualProvider=env.VISUAL_IMAGE_PROVIDER==='runware'?'runware':'fal';
        const context:ProviderContext={provider,falKey:env.FAL_KEY,runwareKey:env.RUNWARE_API_KEY,signal,timings,layout:isWorldLayout(b.layout)?b.layout:undefined,
          reserve:async(step,cost)=>{if(env.GENERATION_ENABLED!=='true')throw new Error('generation_stopped');await ledger('visualReserve',{...args,step,cost});}};
        const save=async(url:string,video:boolean,destination:string,keyColor?:'green'|'blue'):Promise<VisualAsset>=>{
          const fetchStarted=performance.now(),response=await fetch(safeVisualMediaUrl(url),{signal,redirect:'manual'});
          if(!response.ok||!response.headers.get('Content-Type')?.includes(video?'video/mp4':'image/png'))throw new Error('media_type');
          const bytes=await boundedBody(response as unknown as Request,video?32000000:12000000);
          const dimensions=video?undefined:await inspectVisualPng(new Uint8Array(bytes),intent.type==='prop');
          const now=Date.now(),id=(scope==='shared'?'s-':'p-')+await digest(destination+now+ticket.token),expiresAt=now+(scope==='shared'?30:1)*86400000;
          await env.VISUAL_ASSETS!.put(id,bytes,{httpMetadata:{contentType:video?'video/mp4':'image/png'},customMetadata:{expiresAt:String(expiresAt),scope:scope==='shared'?'shared':'private'}});
          const asset:VisualAsset={id,url:id,kind:video?'video':'image',composite:video?'green-key':intent.type==='prop'?'alpha':'opaque',type:intent.type as 'prop'|'background',concept:intent.concept,createdAt:now,expiresAt,scope,...(video?{keyColor,source:source??undefined}:{width:dimensions?.width,height:dimensions?.height})};
          await ledger('visualPublish',{...args,asset,key:destination});timings[video?'videoStorage':'imageStorage']=performance.now()-fetchStarted;return asset;
        };
        const baseStarted=performance.now();
        if(!ticket.video||!source)source=await share('base',baseKey,()=>lookup(baseKey),async()=>save(await generateVisualImage(context,baseIntent,portrait),false,baseKey),!ticket.video&&intent.regenerate?cached?.id:undefined);
        timings.basePreparation=performance.now()-baseStarted;
        if(!ticket.video){emit({type:'asset',asset:await resolve(source!)});code='complete';return;}
        key=await videoKey();
        emit({type:'asset',asset:await resolve(source!)});
        const result=await share('video',key,()=>lookup(key),async()=>{
          const inputStarted=performance.now(),inputKey='input-'+await digest(source!.id+':key-v1');
          const getInput=async()=>{
            const stored=await env.VISUAL_ASSETS!.get(inputKey);
            if(!stored||!['green','blue'].includes(stored.customMetadata?.keyColor??'')||!Number.isFinite(Number(stored.customMetadata?.expiresAt))||Number(stored.customMetadata?.expiresAt)<=Date.now())return null;
            return {id:inputKey,bytes:new Uint8Array(await stored.arrayBuffer()),keyColor:stored.customMetadata!.keyColor as 'green'|'blue'};
          };
          const input=await share('input',inputKey,getInput,async()=>{
            const original=source!.url.startsWith('/manifestation/')?await env.ASSETS.fetch(new Request('https://assets'+source!.url)):await env.VISUAL_ASSETS!.get(source!.id);
            if(!original)throw new Error('source_invalid');
            const value=await videoSourcePng(new Uint8Array(await original.arrayBuffer()));
            await ledger('visualPermission',who).then(p=>{const v=p as {enabled:boolean;generation:number};if(!v.enabled||v.generation!==ticket.generation)throw new Error('visual_disabled');});
            await env.VISUAL_ASSETS!.put(inputKey,value.bytes,{httpMetadata:{contentType:'image/png'},customMetadata:{keyColor:value.keyColor,expiresAt:String(Math.min(source!.expiresAt,Date.now()+(scope==='shared'?30:1)*86400000)),scope:scope==='shared'?'shared':'private'}});
            return {id:inputKey,...value};
          });
          timings.sourcePreparation=performance.now()-inputStarted;
          const response=await callVisualProvider({...context,provider:'fal'},'video',{image_url:'data:image/png;base64,'+Buffer.from(input.bytes).toString('base64'),prompt:`Locked camera. One ${intent.concept} performing this action: ${intent.motion}. Preserve the source appearance. Full silhouette stays inside the frame with a generous margin. Uniform saturated ${input.keyColor} background. No cuts, text, extra subjects, floor or shadows.`,duration:5,resolution:'480P',prompt_expansion_mode:'fast',enable_safety_checker:true});
          const url=String((response.video as {url?:string})?.url);
          if(!ctx)return save(url,true,key,input.keyColor);
          const now=Date.now(),id=(scope==='shared'?'s-':'p-')+await digest(key+now+ticket.token),expiresAt=now+900000;
          await ledger('visualMediaRegister',{...args,key:id,url:safeVisualMediaUrl(url)});
          const asset:VisualAsset={id,url:id,kind:'video',composite:'green-key',type:'prop',concept:intent.concept,createdAt:now,expiresAt,scope,keyColor:input.keyColor,source:source!};
          await ledger('visualPublish',{...args,asset,key});
          const storageStarted=performance.now();
          ctx.waitUntil((async()=>{
            const media=await fetch(safeVisualMediaUrl(url),{signal:AbortSignal.timeout(25000),redirect:'manual'});
            if(!media.ok||!media.headers.get('Content-Type')?.includes('video/mp4'))throw new Error('media_type');
            const bytes=await boundedBody(media as unknown as Request,32000000),fetchMs=performance.now()-storageStarted;
            await env.VISUAL_ASSETS!.put(id,bytes,{httpMetadata:{contentType:'video/mp4'},customMetadata:{expiresAt:String(now+(scope==='shared'?30:1)*86400000),scope:scope==='shared'?'shared':'private'}});
            await ledger('visualMediaSaved',{...who,key:id,enabled:true,timings:{fetchMs,totalMs:performance.now()-storageStarted},eventId:ticket.eventId});
          })().catch(()=>ledger('visualMediaSaved',{...who,key:id,enabled:false,eventId:ticket.eventId,timings:{totalMs:performance.now()-storageStarted}}).catch(()=>{})));
          return asset;
        },intent.regenerate?cached?.id:undefined);
        timings.ready=performance.now()-start;emit({type:'asset',asset:await resolve(result)});code='complete';
      }catch(error){code=error instanceof Error&&/^[\w-]{1,60}$/.test(error.message)?error.message:'visual_failed';emit({type:'failed',code});}
      finally{timings.total=performance.now()-start;await ledger('visualFinish',{...args,code,timings,eventId:ticket.eventId}).catch(()=>{});if(!disconnected)controller.close();}
    },cancel(){disconnected=true;abort.abort();}
  }),{headers:{'Content-Type':'application/x-ndjson','Cache-Control':'no-store'}});
}
