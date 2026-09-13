import { useCallback, useEffect, useRef, useState } from 'react';
import { publicUrl } from '../public/paths';
import { publicFetch, publicSessionId, publicActive } from '../public/session';
import { addWorldHeaders, setWorldAccess, worldAccess, worldFetch, sharedWorldRoomId } from './client';
import type { SharedWorldState, WorldElement } from './state';
import type { VisualAsset } from '../visual/types';
import { cardPool } from '../cards/cardPool';
import type { conversationView } from './conversation';
import type { HandCard, WorldCardSlot } from './hand';
export type WorldSnapshot=Omit<SharedWorldState,'host'>&{hand?:HandCard[];host:{clientId:string;until:number}|null;serverNow:number;receivedAt?:number;sharedConversation?:boolean;conversationView?:ReturnType<typeof conversationView>};
const messages:Record<string,string>={conversation_disabled:'共有会話は休止中です。',conversation_full:'ただいま会話の順番待ちがいっぱいです。',already_waiting:'あなたの入力は受付済みです。',conversation_cooldown:'少し待ってから話しかけてください。',slot_expired:'順番待ちの期限が切れました。',card_rate_limited:'少し待ってから、もう一度どうぞ。',host_already_active:'別の展示端末が動作中です。',host_lease_lost:'展示端末の接続を確認してください。',room_closed:'ただいまカードの受付を休止しています。',invalid_invite:'参加リンクを確認してください。',world_disabled:'共有世界は現在無効です。',visual_disabled:'画像生成はOFFです。カードと既存の演出は使えます。'};
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
        await lease().catch(e=>{if(!current.current?.sharedConversation)setError(worldMessage(e.message));});
        if(stopped)return;
        heartbeat=setInterval(()=>{void lease().catch(e=>{setWorldAccess(null);if(!current.current?.sharedConversation)setError(worldMessage(e.message));});},10000);
      }
      connect();poll=setInterval(()=>{void worldFetch(roomId,'state').then(receive).catch(()=>{});},15000);
    }catch(e){if(!stopped)setError(worldMessage(e instanceof Error?e.message:'world_unavailable'));}})();
    const jobs=activeJobs.current;
    return()=>{stopped=true;socket?.close();clearTimeout(reconnect);clearInterval(heartbeat);clearInterval(poll);setWorldAccess(null);for(const controller of jobs.values())controller.abort();};
  },[roomId,guestRoom,lease,receive]);
  useEffect(()=>{if(!roomId||!snapshot?.sharedConversation)return;const pulse=()=>{void worldFetch(roomId,'presence',{active:publicActive()&&!document.hidden}).catch(()=>{});};pulse();const timer=setInterval(pulse,10000);document.addEventListener('visibilitychange',pulse);window.addEventListener('vayria-public-start',pulse);window.addEventListener('vayria-public-stop',pulse);return()=>{clearInterval(timer);document.removeEventListener('visibilitychange',pulse);window.removeEventListener('vayria-public-start',pulse);window.removeEventListener('vayria-public-stop',pulse);void worldFetch(roomId,'presence',{active:false}).catch(()=>{});};},[roomId,snapshot?.sharedConversation]);
  useEffect(()=>{const failed=(event:Event)=>setError(worldMessage((event as CustomEvent<string>).detail));window.addEventListener('vayria-world-input-error',failed);return()=>window.removeEventListener('vayria-world-input-error',failed);},[]);
  const insert=useCallback(async(cardId:string)=>{
    if(!roomId||!current.current)return;const eventId=crypto.randomUUID();
    try{await worldFetch(roomId,'card',{eventId,cardId,epoch:current.current.epoch});setReceipt(`${cardPool.find(c=>c.id===cardId)?.label??cardId} を受け付けました`);setError('');}catch(e){setError(worldMessage(e instanceof Error?e.message:'world_unavailable'));}
  },[roomId]);
  const insertHand=useCallback(async(handCardId:string,slot:WorldCardSlot,eventId:string)=>{
    if(!roomId||!current.current)return false;
    try{const next=await worldFetch(roomId,'insert',{eventId,handCardId,slotId:slot.id,slotVersion:slot.version,epoch:current.current.epoch});receive(next);
      if(next.accepted===false){setError('その枠は先に変更されました。差し込み先を選び直してください。');return false;}
      setReceipt('カードを受け付けました');setError('');return true;
    }catch(e){setError(worldMessage(e instanceof Error?e.message:'world_unavailable'));return false;}
  },[roomId,receive]);
  const nextParticipant=useCallback(async()=>{if(!roomId||!current.current?.cardSlots)return;try{receive(await worldFetch(roomId,'hand-reset',{epoch:current.current.epoch,eventId:crypto.randomUUID()}));setReceipt('次の方の手札を引きました');}catch{setError('手札を更新できませんでした。接続を確認してください。');}},[roomId,receive]);
  useEffect(()=>{const next=()=>{void nextParticipant();};window.addEventListener('vayria-exhibition-next',next);return()=>window.removeEventListener('vayria-exhibition-next',next);},[nextParticipant]);
  const displayed=useCallback(async(elementId:string)=>{
    if(!roomId||(!current.current?.sharedConversation&&!worldAccess()))return false;
    try{await worldFetch(roomId,current.current?.sharedConversation?'display':'element',{elementId,status:'displayed',epoch:current.current?.epoch});return true;}catch{return false;}
  },[roomId]);
  useEffect(()=>{
    if(snapshot?.sharedConversation)return;
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
  const send=useCallback(async(text:string)=>{if(!roomId||!current.current)return false;try{receive(await worldFetch(roomId,'conversation',{id:crypto.randomUUID(),kind:'text',text,epoch:current.current.epoch}));setError('');return true;}catch(e){setError(worldMessage(e instanceof Error?e.message:'world_unavailable'));return false;}},[roomId,receive]);
  return {send,enabled,roomId,snapshot,sweepElements,error,receipt,connected,role,insert,insertHand,nextParticipant,displayed,takeover:()=>lease(true)};
}
export type SharedWorldClient=ReturnType<typeof useSharedWorld>;
export function worldElementIcon(element:WorldElement){return element.sourceCardIds[0]??element.concept;}
export { addWorldHeaders };
