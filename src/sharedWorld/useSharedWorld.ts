import { useCallback, useEffect, useRef, useState } from 'react';
import { publicUrl } from '../public/paths';
import { publicFetch, publicSessionId } from '../public/session';
import { addWorldHeaders, setWorldAccess, worldAccess, worldFetch, sharedWorldRoomId } from './client';
import type { SharedWorldState, WorldElement } from './state';
import type { VisualAsset } from '../visual/types';
import { cardPool } from '../cards/cardPool';
export type WorldSnapshot=Omit<SharedWorldState,'host'>&{host:{clientId:string;until:number}|null;serverNow:number;receivedAt?:number};
const messages:Record<string,string>={card_rate_limited:'少し待ってから、もう一度どうぞ。',host_already_active:'別の展示端末が動作中です。',host_lease_lost:'展示端末の接続を確認してください。',room_closed:'ただいまカードの受付を休止しています。',invalid_invite:'参加リンクを確認してください。',world_disabled:'共有世界は現在無効です。',visual_disabled:'画像生成はOFFです。カードと既存の演出は使えます。'};
export const worldMessage=(code:string)=>messages[code]??`接続を確認してください (${code})`;
export function useSharedWorld(guestRoom?:string){
  const roomId=guestRoom??sharedWorldRoomId();const enabled=!!roomId;
  const [snapshot,setSnapshot]=useState<WorldSnapshot|null>(null);const [error,setError]=useState('');const [receipt,setReceipt]=useState('');
  const [connected,setConnected]=useState(false);const [role,setRole]=useState<'guest'|'host'>('guest');
  const [sweepElements,setSweepElements]=useState<WorldElement[]>([]);
  // A duplicated tab must not inherit the exhibition lease of its opener.
  const [clientId]=useState(()=>crypto.randomUUID());
  const current=useRef(snapshot);const previousEpoch=useRef<number|null>(null);const attempted=useRef(new Set<string>());const activeJobs=useRef(new Map<string,AbortController>());
  const receive=useCallback((next:WorldSnapshot)=>{
    if(!next?.roomId)return;
    next={...next,receivedAt:Date.now()};
    if(current.current&&next.revision<current.current.revision)return;
    if(previousEpoch.current!==null&&previousEpoch.current!==next.epoch){setSweepElements(current.current?.elements??[]);for(const controller of activeJobs.current.values())controller.abort();attempted.current.clear();}
    previousEpoch.current=next.epoch;current.current=next;setSnapshot(next);
    window.dispatchEvent(new CustomEvent('vayria-world-state',{detail:next}));
    const auth=worldAccess();if(auth&&auth.roomId===next.roomId&&auth.epoch!==next.epoch)setWorldAccess({...auth,epoch:next.epoch});
  },[]);
  const lease=useCallback(async(takeover=false)=>{
    if(!roomId)return;const value=await worldFetch(roomId,'lease',{clientId,takeover});setWorldAccess({roomId,clientId,lease:value.token,epoch:value.epoch,until:Date.now()+value.until-value.serverNow});setError('');
  },[roomId,clientId]);
  useEffect(()=>{
    if(!roomId)return;let stopped=false;let socket:WebSocket|undefined;let reconnect:ReturnType<typeof setTimeout>|undefined;
    let heartbeat:ReturnType<typeof setInterval>|undefined;let poll:ReturnType<typeof setInterval>|undefined;let retryMs=1000;
    const connect=()=>{
      if(stopped)return;const url=new URL(publicUrl(`/api/world-room/${roomId}/events`),location.origin);url.protocol=url.protocol==='https:'?'wss:':'ws:';
      socket=new WebSocket(url);socket.onopen=()=>{retryMs=1000;setConnected(true);};socket.onmessage=e=>{const value=JSON.parse(e.data);if(value.roomId)receive(value);};
      socket.onclose=()=>{setConnected(false);if(!stopped){reconnect=setTimeout(connect,retryMs);retryMs=Math.min(15000,retryMs*2);}};
      socket.onerror=()=>socket?.close();
    };
    void(async()=>{try{
      const hash=new URLSearchParams(location.hash.slice(1));const grant=hash.get('host')??hash.get('invite')??'';
      const joined=await worldFetch(roomId,'join',{grant});if(stopped)return;setRole(joined.role);receive(joined.state);
      if(grant)history.replaceState(null,'',location.pathname+location.search);
      if(joined.role==='host'&&!guestRoom){
        await lease().catch(e=>setError(worldMessage(e.message)));
        if(stopped)return;
        heartbeat=setInterval(()=>{void lease().catch(e=>{setWorldAccess(null);setError(worldMessage(e.message));});},10000);
      }
      connect();poll=setInterval(()=>{void worldFetch(roomId,'state').then(receive).catch(()=>{});},15000);
    }catch(e){if(!stopped)setError(worldMessage(e instanceof Error?e.message:'world_unavailable'));}})();
    const jobs=activeJobs.current;
    return()=>{stopped=true;socket?.close();clearTimeout(reconnect);clearInterval(heartbeat);clearInterval(poll);setWorldAccess(null);for(const controller of jobs.values())controller.abort();};
  },[roomId,guestRoom,lease,receive]);
  const insert=useCallback(async(cardId:string)=>{
    if(!roomId||!current.current)return;const eventId=crypto.randomUUID();
    try{await worldFetch(roomId,'card',{eventId,cardId,epoch:current.current.epoch});setReceipt(`${cardPool.find(c=>c.id===cardId)?.label??cardId} を受け付けました`);setError('');}catch(e){setError(worldMessage(e instanceof Error?e.message:'world_unavailable'));}
  },[roomId]);
  const displayed=useCallback(async(elementId:string)=>{
    if(!roomId||!worldAccess())return false;
    try{await worldFetch(roomId,'element',{elementId,status:'displayed'});return true;}catch{return false;}
  },[roomId]);
  useEffect(()=>{
    if(!roomId||role!=='host'||!snapshot||!worldAccess()||!publicSessionId())return;
    for(const element of snapshot.elements.filter(e=>e.status==='preparing')){
      const key=`${snapshot.epoch}:${element.id}`;if(attempted.current.has(key)||activeJobs.current.size>=2)continue;
      attempted.current.add(key);const controller=new AbortController();activeJobs.current.set(key,controller);
      void(async()=>{try{
        const ticket=await worldFetch(roomId,'prepare',{elementId:element.id},controller.signal);
        const response=await publicFetch('/api/visual/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:ticket.visualTicket,portrait:innerHeight>innerWidth,remainingMs:element.kind==='background'?60000:30000}),signal:controller.signal});
        if(!response.ok){const error=await response.json();throw new Error(error.code??'generation_failed');}
        let asset:VisualAsset|undefined;
        const accept=(value:{type:string;asset?:VisualAsset;code?:string})=>{if(value.type==='asset')asset=value.asset;if(value.type==='failed')throw new Error(value.code??'generation_failed');};
        if(response.headers.get('Content-Type')?.includes('ndjson')){
          const reader=response.body!.pipeThrough(new TextDecoderStream()).getReader();let buffer='';
          try{for(;;){const r=await reader.read();if(r.done)break;buffer+=r.value;let i;while((i=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())accept(JSON.parse(line));}}if(buffer.trim())accept(JSON.parse(buffer));}finally{await reader.cancel().catch(()=>{});}
        }else accept(await response.json());
        if(!asset)throw new Error('asset_unavailable');controller.signal.throwIfAborted();
        await worldFetch(roomId,'asset',{elementId:element.id,asset},controller.signal);
      }catch(e){if(!controller.signal.aborted&&(!(e instanceof Error)||e.message!=='generation_already_requested'))await worldFetch(roomId,'element',{elementId:element.id,status:'failed',code:e instanceof Error?e.message:'generation_failed'}).catch(()=>{});}
      finally{activeJobs.current.delete(key);}})();
    }
  },[roomId,role,snapshot]);
  return {enabled,roomId,snapshot,sweepElements,error,receipt,connected,role,insert,displayed,takeover:()=>lease(true)};
}
export type SharedWorldClient=ReturnType<typeof useSharedWorld>;
export function worldElementIcon(element:WorldElement){return element.sourceCardIds[0]??element.concept;}
export { addWorldHeaders };
