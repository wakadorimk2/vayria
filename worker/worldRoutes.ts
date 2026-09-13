import { boundedBody, cookie, sign, verify } from './security';
import { LimitError } from './ledger';
import { validId } from '../src/sharedWorld/state';
import { visualTicket, type VisualEnv, type VisualLedger } from './visual';
import type { VisualAsset } from '../src/visual/types';

export interface WorldEnv extends VisualEnv { WORLD_ROOMS?:DurableObjectNamespace; SHARED_WORLD_ENABLED?:string; SHARED_CONVERSATION_ENABLED?:string }
type Credential={purpose:'world-member';roomId:string;actor:string;role:'guest'|'host';exp:number};
const cookieName=(env:WorldEnv)=>env.PUBLIC_BASE_PATH?'__Host-vayria-world-staging':'__Host-vayria-world';
export async function worldMember(request:Request,env:WorldEnv){const c=await verify<Credential>(cookie(request,cookieName(env)),env.COOKIE_SECRET);return c?.purpose==='world-member'?c:null;}
export async function worldCall(env:WorldEnv,roomId:string,actor:string,role:string,input:object){
  if(env.SHARED_WORLD_ENABLED!=='true'||!env.WORLD_ROOMS||!validId(roomId))throw new LimitError('world_disabled',0,404);
  const response=await env.WORLD_ROOMS.get(env.WORLD_ROOMS.idFromName(roomId)).fetch('https://world/',{method:'POST',headers:{'X-World-Actor':actor,'X-World-Role':role},body:JSON.stringify(input)});
  const result=await response.json() as Record<string,unknown>;if(!response.ok)throw new LimitError(String(result.code),0,response.status);return result;
}
export async function createWorld(env:WorldEnv,roomId:string,origin:string){
  await worldCall(env,roomId,'admin','admin',{op:'create',roomId});
  const expires=Date.now()+7*86400000;
  const invite=await sign({purpose:'world-invite',roomId,exp:expires},env.COOKIE_SECRET);
  const host=await sign({purpose:'world-host',roomId,exp:expires},env.COOKIE_SECRET);
  const base=origin+(env.PUBLIC_BASE_PATH??'');
  return {roomId,joinUrl:`${base}/world/${roomId}#invite=${encodeURIComponent(invite)}`,hostUrl:`${base}/?world=${roomId}#host=${encodeURIComponent(host)}`,expires};
}
export function worldLease(request:Request){return {clientId:request.headers.get('X-World-Client'),lease:request.headers.get('X-World-Lease'),epoch:Number(request.headers.get('X-World-Epoch'))};}
export async function guardWorldRequest(request:Request,env:WorldEnv){
  const member=await worldMember(request,env);if(!member)return null;
  if(member.role!=='host')throw new LimitError('world_guest_read_only',0,403);
  const context=await worldCall(env,member.roomId,member.actor,member.role,{op:'guard',...worldLease(request)});return {member,context:String(context.context)};
}
export async function worldRoute(request:Request,env:WorldEnv,ledger:VisualLedger,visitor:string,session:string){
  if(env.SHARED_WORLD_ENABLED!=='true'||!env.WORLD_ROOMS)throw new LimitError('world_disabled',0,404);
  const url=new URL(request.url);const match=/^\/api\/world-room\/([\w-]+)\/(join|state|events|card|insert|hand-reset|lease|element|prepare|asset|media|conversation|cancel|voice|display|presence|generation)(?:\/([\w-]+))?$/.exec(url.pathname);
  if(!match)throw new LimitError('not_found',0,404);const [,roomId,op,assetId]=match;
  const input=request.method==='POST'&&op!=='voice'?JSON.parse(new TextDecoder().decode(await boundedBody(request,18000))) as Record<string,unknown>:{};
  if(op==='join'&&request.method==='POST'){
    const grant=await verify<{purpose:string;roomId:string;exp:number}>(String(input.grant??''),env.COOKIE_SECRET);
    const old=await worldMember(request,env);
    if((!grant||grant.roomId!==roomId||!['world-host','world-invite'].includes(grant.purpose))&&old?.roomId!==roomId)throw new LimitError('invalid_invite',0,403);
    const role=grant?.purpose==='world-host'?'host':old?.roomId===roomId?old.role:'guest';
    const actor=old?.roomId===roomId?old.actor:crypto.randomUUID();
    const state=await worldCall(env,roomId,actor,role,{op:'join'});
    const credential:Credential={purpose:'world-member',roomId,actor,role,exp:Date.now()+7*86400000};
    const response=Response.json({state,role,name:`参加者${actor.slice(0,4)}`});
    response.headers.set('Set-Cookie',`${cookieName(env)}=${await sign(credential,env.COOKIE_SECRET)}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=604800`);return response;
  }
  const member=await worldMember(request,env);if(!member||member.roomId!==roomId)throw new LimitError('room_membership_required',0,403);
  if(op==='events'&&request.headers.get('Upgrade')==='websocket'){
    if(request.headers.get('Origin')!==url.origin)throw new LimitError('invalid_origin',0,403);
    return env.WORLD_ROOMS.get(env.WORLD_ROOMS.idFromName(roomId)).fetch(new Request('https://world/events',{headers:{Upgrade:'websocket','X-World-Actor':member.actor,'X-World-Role':member.role}}));
  }
  const call=(value:object)=>worldCall(env,roomId,member.actor,member.role,value);
  if(op==='generation'&&request.method==='POST'){
    if(env.SHARED_CONVERSATION_ENABLED!=='true'||env.MANIFESTATION_ENABLED!=='true'||typeof input.enabled!=='boolean'||!Number.isSafeInteger(input.generation))throw new LimitError('invalid_permission',0,400);
    return Response.json(await ledger('visualMode',{visitor,id:session,enabled:input.enabled,generation:input.generation}));
  }
  if(op==='presence'&&request.method==='POST'){
    if(env.SHARED_CONVERSATION_ENABLED!=='true')throw new LimitError('conversation_disabled',0,409);
    const status=session?await ledger<{stopped:boolean;session:{id:string;expires:number}|null}>('status',{visitor}):null;
    const active=input.active===true&&env.GENERATION_ENABLED==='true'&&!status?.stopped&&status?.session?.id===session&&status.session.expires>Date.now();
    return Response.json(await call({op,visitor:active?visitor:'',session:active?session:''}));
  }
  if(['conversation','voice','cancel','display'].includes(op)){
    if(request.method!=='POST')throw new LimitError('method_not_allowed',0,405);
    if(env.SHARED_CONVERSATION_ENABLED!=='true')throw new LimitError('conversation_disabled',0,409);
    if(op==='conversation'||op==='voice'){
      if(env.GENERATION_ENABLED!=='true')throw new LimitError('generation_stopped',0,503);
      const status=await ledger<{stopped:boolean;session:{id:string;expires:number}|null}>('status',{visitor});
      if(status.stopped||!status.session||status.session.id!==session||status.session.expires<=Date.now())throw new LimitError('session_required',0,403);
    }
    if(op==='voice'){
      const audio=await boundedBody(request,640044);
      return env.WORLD_ROOMS.get(env.WORLD_ROOMS.idFromName(roomId)).fetch('https://world/voice',{method:'POST',headers:{'X-World-Actor':member.actor,'X-World-Slot':request.headers.get('X-World-Slot')??'','X-World-Epoch':request.headers.get('X-World-Epoch')??''},body:audio as Uint8Array<ArrayBuffer>});
    }
    return Response.json(await call({...input,op,visitor,session}));
  }
  if(op==='media'&&request.method==='GET'){
    if((member.role!=='host'&&env.SHARED_CONVERSATION_ENABLED!=='true')||!assetId)throw new LimitError('forbidden',0,403);
    const asset=await env.VISUAL_ASSETS?.get(`world/${roomId}/${assetId}`);if(!asset)throw new LimitError('not_found',0,404);
    if(asset.customMetadata?.expires&&Number(asset.customMetadata.expires)<Date.now()){await env.VISUAL_ASSETS?.delete(`world/${roomId}/${assetId}`);throw new LimitError('not_found',0,404);}
    return new Response(asset.body,{headers:{'Content-Type':asset.httpMetadata?.contentType??'image/png','Cache-Control':'private, max-age=300','X-Content-Type-Options':'nosniff'}});
  }
  if(op==='state'&&request.method==='GET')return Response.json(await call({op}));
  if(request.method!=='POST')throw new LimitError('method_not_allowed',0,405);
  if(['card','insert','hand-reset'].includes(op))return Response.json(await call({...input,op}));
  if(member.role!=='host')throw new LimitError('forbidden',0,403);
  if(op==='lease')return Response.json(await call({...input,op}));
  await call({op:'guard',...worldLease(request)});
  if(op==='prepare'){
    const state=await call({op:'state'});const element=(state.elements as {id:string;concept:string;kind:'prop'|'background';status:string}[]).find(e=>e.id===input.elementId&&e.status==='preparing');
    if(!element)throw new LimitError('element_not_found',0,404);
    const p=await ledger<{enabled:boolean;generation:number}>('visualPermission',{visitor,id:session});if(!p.enabled)throw new LimitError('visual_disabled',0,409);
    await call({op:'claim',...worldLease(request),elementId:element.id});
    return Response.json(await visualTicket({visualIntent:{type:element.kind,action:'add',concept:element.concept,modifiers:[],targetId:element.id,motion:'',motionEvidence:'',sharing:'general',regenerate:false}},env,visitor,session,p.generation,false,element.id));
  }
  if(op==='asset'){
    const candidate=input.asset as VisualAsset; if(!candidate||candidate.kind!=='image'||typeof candidate.url!=='string')throw new LimitError('invalid_asset',0,400);
    let assetUrl:string;
    if(/^stock-(chicken-1|egg|feather|bat)$/.test(candidate.id)&&candidate.url===(env.PUBLIC_BASE_PATH??'')+'/manifestation/'+candidate.id.slice(6)+'.png')assetUrl=candidate.url;
    else{
      const assetUrlParsed=new URL(candidate.url,'https://local');
      const proof=await verify<{purpose:string;visitor:string;session:string;key:string;exp:number}>(assetUrlParsed.searchParams.get('ticket')??'',env.COOKIE_SECRET);
      if(!proof||proof.purpose!=='visual-media'||proof.visitor!==visitor||proof.session!==session||proof.key!==candidate.id)throw new LimitError('invalid_asset',0,403);
      const source=await env.VISUAL_ASSETS?.get(proof.key);if(!source||!env.VISUAL_ASSETS)throw new LimitError('asset_unavailable',0,404);
      await env.VISUAL_ASSETS.put(`world/${roomId}/${candidate.id}`,source.body,{httpMetadata:{contentType:'image/png'},customMetadata:{scope:'world',roomId}});
      assetUrl=`${env.PUBLIC_BASE_PATH??''}/api/world-room/${roomId}/media/${candidate.id}`;
    }
    return Response.json(await call({op:'element',...worldLease(request),elementId:input.elementId,status:'ready',assetUrl}));
  }
  if(op==='element')return Response.json(await call({...input,op,...worldLease(request),status:input.status==='displayed'?'displayed':'failed'}));
  throw new LimitError('not_found',0,404);
}
