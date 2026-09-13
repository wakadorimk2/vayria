import { publicSessionId } from '../public/session';
import { publicUrl } from '../public/paths';
import { sharedWorldRoomId, worldFetch } from './client';
import type { WorldSnapshot } from './useSharedWorld';

let state:WorldSnapshot|null=null;
if(typeof window!=='undefined')window.addEventListener('vayria-world-state',event=>{state=(event as CustomEvent<WorldSnapshot>).detail;});
export const sharedConversationActive=()=>!!sharedWorldRoomId()&&state?.sharedConversation===true;
export function reserveSharedVoice(){
  const roomId=sharedWorldRoomId();const epoch=state?.epoch;if(!roomId||epoch===undefined)throw new Error('world_unavailable');
  const id=crypto.randomUUID();let submitted=false;const controller=new AbortController();
  const reservation=worldFetch(roomId,'conversation',{id,kind:'voice',epoch},controller.signal) as Promise<WorldSnapshot>;
  void reservation.catch(error=>{if(!controller.signal.aborted)window.dispatchEvent(new CustomEvent('vayria-world-input-error',{detail:error instanceof Error?error.message:'world_unavailable'}));});
  const cancel=()=>{controller.abort();if(!submitted)void worldFetch(roomId,'cancel',{id,epoch}).catch(()=>{});};
  const send=async(audio:ArrayBuffer,externalSignal:AbortSignal):Promise<Response>=>{
  const signal=AbortSignal.any([controller.signal,externalSignal]);
  try{
    let next=await reservation;
    const deadline=Date.now()+120000;
    for(;;){
      signal.throwIfAborted();
      window.dispatchEvent(new CustomEvent('vayria-world-state',{detail:next}));
      const slot=next.conversationView?.slot;
      if(next.epoch!==epoch||slot?.id!==id||Date.now()>deadline)throw new Error('slot_expired');
      if(slot.status==='granted')break;
      await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);reject(new DOMException('Aborted','AbortError'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},1000);signal.addEventListener('abort',abort,{once:true});});
      next=await worldFetch(roomId,'state',undefined,signal);
    }
    const response=await fetch(publicUrl(`/api/world-room/${roomId}/voice`),{method:'POST',headers:{'Content-Type':'audio/wav','X-Vayria-Session':publicSessionId(),'X-World-Slot':id,'X-World-Epoch':String(epoch)},body:audio,signal});
    submitted=response.ok;return response;
  }finally{if(!submitted)cancel();}
  };
  return {send,cancel};
}
export const sendSharedVoice=(audio:ArrayBuffer,signal:AbortSignal)=>reserveSharedVoice().send(audio,signal);
