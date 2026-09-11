import { VisualModeError, visualModeErrorMessage } from './modeError';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { publicFetch, publicSessionId, requestPublicSession } from '../public/session';
import { runtimeConfig } from '../runtimeConfig';
import { prepareObject, releasePrepared } from '../manifestation/media';
import { setVisualAccess } from './access';
import { VisualSession } from './session';
import type { VisualAsset } from './types';
export function useVisualGeneration(){
  const [busy,setBusy]=useState(false),[message,setMessage]=useState('');
  const [client]=useState(()=>{
    let serial=Promise.resolve();let revision=0;
    const runtime=new VisualSession({now:Date.now,release:asset=>releasePrepared(asset.url),
      diagnostic:(event,id,milliseconds)=>{if(runtimeConfig.mode==='public'&&runtimeConfig.manifestationEnabled)console.info('[visual]',JSON.stringify({event,id,at:Date.now(),milliseconds}));},
      cancel:async(ticket)=>{await publicFetch('/api/visual/cancel',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket})});},
      prepare:async(asset,signal)=>{
        if(asset.kind==='video'){await prepareObject({...asset,composite:'green-key',mode:'reused-base-video',timings:{}},signal);return;}
        const image=new Image();image.src=asset.url;await image.decode().catch(()=>{throw new Error('image_decode_failed');});signal.throwIfAborted();
      },
      generate:async(job,signal,onAsset)=>{
        const response=await publicFetch('/api/visual/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({ticket:job.ticket,remainingMs:Math.max(1,(job.intent.type==='background'?60000:30000)-(Date.now()-job.at)),portrait:runtime.getLayout().height>runtime.getLayout().width,layout:runtime.getLayout()}),signal});
        console.info('[visual-response]',JSON.stringify({id:job.id,status:response.status,stream:response.headers.get('Content-Type')?.includes('ndjson')===true}));
        const receive=async(value:{type:string;asset?:VisualAsset;code?:string})=>{if(value.type==='asset'&&value.asset){console.info('[visual-response]',JSON.stringify({id:job.id,stage:'asset_received'}));await onAsset(value.asset);}if(value.type==='failed')throw new Error(value.code??'visual_failed');};
        if(!response.ok){const value=await response.json();throw new Error(value.code??'visual_failed');}
        if(!response.headers.get('Content-Type')?.includes('ndjson')){await receive(await response.json());return;}
        const reader=response.body!.pipeThrough(new TextDecoderStream()).getReader();let pending='';
        try{for(;;){const r=await reader.read();if(r.done)break;pending+=r.value;let index;while((index=pending.indexOf('\n'))>=0){const line=pending.slice(0,index);pending=pending.slice(index+1);if(line.trim())await receive(JSON.parse(line));}}if(pending.trim())await receive(JSON.parse(pending));}
        finally{await reader.cancel().catch(()=>{});}
      },
    });
    const mode=(enabled:boolean)=>{
      const requestedRevision=++revision;
      if(!enabled){setVisualAccess(null);runtime.permission(false,runtime.getSnapshot().generation);}
      serial=serial.catch(()=>{}).then(async()=>{
        if(!publicSessionId())throw new VisualModeError(401,'session_required');
        const response=await publicFetch('/api/visual/mode',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled,generation:runtime.getSnapshot().generation})});
        if(!response.ok){const body=await response.json().catch(()=>null);const error=new VisualModeError(response.status,body?.code);console.info('[visual-mode]',JSON.stringify({status:error.status,code:error.code}));throw error;}const p=await response.json() as {enabled:boolean;generation:number};
        const active=requestedRevision===revision&&p.enabled;
        runtime.permission(active,p.generation);setVisualAccess(active?p.generation:null);
      });return serial;
    };return{runtime,mode,reset:()=>{runtime.reset();void mode(false).catch(()=>{});}};
  });
  const snapshot=useSyncExternalStore(client.runtime.subscribe,client.runtime.getSnapshot);
  useEffect(()=>{
    if(runtimeConfig.mode!=='public'||!runtimeConfig.manifestationEnabled)return;
    const off=()=>{void client.mode(false).catch(()=>{});};
    window.addEventListener('vayria-public-start',off);window.addEventListener('vayria-public-stop',off);
    const timer=setInterval(()=>client.runtime.tick(),100);
    return()=>{window.removeEventListener('vayria-public-start',off);window.removeEventListener('vayria-public-stop',off);clearInterval(timer);setVisualAccess(null);client.runtime.reset();};
  },[client]);
  const toggle=async()=>{if(busy)return;setBusy(true);try{if(!snapshot.enabled&&!await requestPublicSession())return;await client.mode(!snapshot.enabled);setMessage(client.runtime.getSnapshot().enabled?'生成モード ON。カードや会話に応じて背景・小物が変化します。':'生成モード OFF。新しい変化を止めました。');}catch(error){setMessage(visualModeErrorMessage(error));}finally{setBusy(false);}};
  return{runtime:client.runtime,snapshot,busy,message,toggle,reset:client.reset};
}
