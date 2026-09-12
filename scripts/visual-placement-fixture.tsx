// Manual DOM/CSS regression fixture. No API calls or generated assets.
import {useState,useEffect,useSyncExternalStore,useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {VisualSession,visualDisplayAge} from '../src/visual/session';
import {VisualStage} from '../src/visual/VisualStage';
import type {VrmStageHandle} from '../src/avatar/VrmStage';
import '../src/public/public.css';
const runtime=new VisualSession({now:Date.now,prepare:async()=>{},generate:async(job,_signal,accept)=>{await accept({id:job.id,url:'/manifestation/chicken-1.png',kind:'image',composite:'alpha',type:'prop',concept:'chicken',width:1024,height:1024,createdAt:0,expiresAt:9999999999999,scope:'shared'});}});
export function Fixture(){
 const [covered,setCovered]=useState(false),[subtitle,setSubtitle]=useState(true);
 const snapshot=useSyncExternalStore(runtime.subscribe,runtime.getSnapshot);
 const stage=useRef({readWorldRegions:()=>({body:{x:innerWidth*.1,y:innerHeight*.1,width:innerWidth*.8,height:innerHeight*.8},face:{x:innerWidth*.3,y:innerHeight*.1,width:innerWidth*.4,height:innerHeight*.3}})} as VrmStageHandle);
 useEffect(()=>{runtime.permission(true,1);runtime.dispatch('fixture',{type:'prop',action:'add',concept:'chicken',modifiers:[],targetId:'chicken',motion:'',motionEvidence:'',sharing:'general',regenerate:false},'local',1);const timer=setInterval(()=>runtime.tick(),100);return()=>clearInterval(timer);},[]);
 const object=snapshot.objects[0]??snapshot.ready?.[0];
 return <div className="public-layout"><div className="app-shell" style={{position:'fixed',inset:0,background:'#32283e'}}>
  <div style={{position:'absolute',left:'30%',top:'10%',width:'40%',height:'30%',background:'#81708d',borderRadius:'50%'}}>顔の保護領域</div>
  <VisualStage runtime={runtime} snapshot={snapshot} stage={stage}/>
  {subtitle&&<div className="conversation-copy" style={{position:'absolute',left:'20%',top:'43%',width:'60%',height:'8%',background:'#75637a',zIndex:20}}>字幕を表示しています</div>}
  <div className="public-controls__panel" style={{display:covered?'block':'none',visibility:'visible',opacity:1,position:'absolute',inset:0,width:'100%',height:'100%',maxWidth:'none',background:'#564860',zIndex:30}}>UIで全面を保護</div>
  <div className="card-zone" style={{visibility:'hidden',position:'absolute',inset:'30% 0 10%'}}>非表示のカード</div>
  <div className="public-controls__actions" style={{position:'absolute',bottom:0,left:'10%',width:'80%',height:45}}>操作領域</div>
  <nav style={{position:'fixed',top:0,left:0,zIndex:100,background:'white',color:'black'}}>
   <button onClick={()=>setCovered(v=>!v)}>全面UI切替</button><button onClick={()=>setSubtitle(v=>!v)}>字幕切替</button>
   <output data-held={String(object?.held??false)} data-age={object?Math.round(visualDisplayAge(object,snapshot.now)):0}>{object?.held?'保留':'表示'} / {snapshot.objects.length+(snapshot.ready?.length??0)}</output>
  </nav>
 </div></div>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
