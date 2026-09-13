import { useEffect, useRef, useState } from 'react';
import type { PlayAudio } from '../audio/useAudioLipSync';
import type { WorldSnapshot } from './useSharedWorld';
import { normalizeEmotion, type Emotion } from '../character/emotion';
import { sharedReplyPlayback } from './replyPlayback';

export function SharedConversation({snapshot,muted,play,stop,onEmotion,onMotion}:{snapshot:WorldSnapshot|null;muted:boolean;play:PlayAudio;stop:()=>void;onEmotion:(emotion:Emotion)=>void;onMotion:(asset:string,id:number)=>void}){
  const current=useRef({muted,play,stop,onEmotion,onMotion});
  const [now,setNow]=useState(Date.now);
  useEffect(()=>{current.current={muted,play,stop,onEmotion,onMotion};},[muted,play,stop,onEmotion,onMotion]);
  useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),250);return()=>clearInterval(timer);},[]);
  const reply=snapshot?.conversationView?.reply;
  const offset=snapshot?snapshot.serverNow-(snapshot.receivedAt??snapshot.serverNow):0;
  const payload=useRef({reply,epoch:snapshot?.epoch,offset});
  useEffect(()=>{payload.current={reply,epoch:snapshot?.epoch,offset};},[reply,snapshot?.epoch,offset]);
  const replyKey=reply?`${snapshot?.roomId}:${snapshot?.epoch}:${reply.id}`:'';
  useEffect(()=>{
    const {reply,epoch,offset}=payload.current;
    if(!reply||epoch===undefined)return;
    const key=replyKey;
    // Reconnection may show the current caption; it never replays old speech.
    if(reply.startsAt<Date.now()+offset-1500||reply.endsAt<=Date.now()+offset)return;
    const controller=new AbortController();let started=false;
    const audio=reply.audioUrl?fetch(reply.audioUrl,{signal:controller.signal}).then(async response=>response.ok?{kind:'buffer' as const,data:await response.arrayBuffer(),mimeType:response.headers.get('Content-Type')??'audio/mpeg'}:null).catch(()=>null):Promise.resolve(null);
    const cancel=()=>{if(controller.signal.aborted)return;controller.abort();if(started)current.current.stop();};
    const timer=setTimeout(()=>{if(!sharedReplyPlayback.claim(key,cancel)){controller.abort();return;}console.debug('[shared-speech]',JSON.stringify({key,event:'received'}));current.current.onEmotion(normalizeEmotion(reply.emotion));
      if(reply.motion==='speech-gentle')current.current.onMotion(reply.motion,reply.id.split('').reduce((n,c)=>(n*31+c.charCodeAt(0))>>>0,0));
      if(!reply.audioUrl||current.current.muted)return;
      void(async()=>{try{const source=await audio;if(!source||controller.signal.aborted||current.current.muted||reply.endsAt<=Date.now()+offset)return;started=true;await current.current.play(source,{onStart:()=>console.debug('[shared-speech]',JSON.stringify({key,event:'started',bytes:source.data.byteLength}))});console.debug('[shared-speech]',JSON.stringify({key,event:'ended'}));}catch{/* Captions remain available when playback is unavailable. */}})();
    },Math.max(0,reply.startsAt-Date.now()-offset));
    return()=>{clearTimeout(timer);cancel();sharedReplyPlayback.release(key);};
  },[replyKey]); // A receipt must not restart the playing reply.
  useEffect(()=>{const cancel=()=>sharedReplyPlayback.stop();window.addEventListener('vayria-public-stop',cancel);return()=>window.removeEventListener('vayria-public-stop',cancel);},[]);
  const live=reply&&reply.endsAt>now+offset;
  return live?<div className="shared-conversation-caption subtitle" aria-live="polite"><p>{reply.text}</p>{reply.error&&<small>音声を再生できませんでした。</small>}</div>:null;
}
