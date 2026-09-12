import {playVideo,VideoFrameProgress} from '../manifestation/videoPlayback';
import { useEffect, useRef, type RefObject } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import { useWorldLayout } from '../world/useWorldLayout';
import { placeWorldProp, type WorldRect } from '../world/worldLayout';
import { preparedVideos, keyGreen, inspectVideoFrame, videoInspectionVersions } from '../manifestation/media';
import type { VisualObject, VisualSession, VisualSnapshot } from './session';
import './visual.css';
function VisualVideo({object,runtime}:{object:VisualObject;runtime:VisualSession}){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const video=preparedVideos.get(object.asset.url),ctx=ref.current?.getContext('2d',{willReadFrequently:true});if(!video||!ctx)return;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;let frame=0,stopped=false,confirmed=false;
    const signal=new AbortController(),progress=new VideoFrameProgress(),id=object.eventId??object.id;
    const canvas=ref.current!;canvas.width=Math.min(video.videoWidth,768);canvas.height=Math.round(canvas.width*video.videoHeight/video.videoWidth);
    const fail=(code:string)=>{if(stopped)return;runtime.mediaStage(id,code);runtime.placementFailed(object.id,object.asset.id,code);};
    let watchdog:ReturnType<typeof setTimeout>|undefined;
    let checked=-1;
    const schedule=()=>{if('requestVideoFrameCallback' in video)frame=video.requestVideoFrameCallback(draw);else frame=requestAnimationFrame(draw);};
    const draw=()=>{if(stopped)return;
      try {const sample=Math.floor(video.currentTime);if(sample!==checked&&!videoInspectionVersions.has(object.asset.id)){inspectVideoFrame(video,object.asset.keyColor);checked=sample;if(video.currentTime>=video.duration*.75){videoInspectionVersions.set(object.asset.id,1);if(videoInspectionVersions.size>100)videoInspectionVersions.delete(videoInspectionVersions.keys().next().value!);}}}
      catch(error){fail(error instanceof Error?error.message:'key_quality');return;}
      clearTimeout(watchdog);watchdog=setTimeout(()=>fail('video_frame_stalled'),4000);
ctx.drawImage(video,0,0,canvas.width,canvas.height);const image=ctx.getImageData(0,0,canvas.width,canvas.height);keyGreen(image.data,object.asset.keyColor);ctx.putImageData(image,0,0);
      if(reduced){runtime.mediaStage(id,'video_reduced_motion');runtime.placementFailed(object.id,object.asset.id,'video_reduced_motion');return;}
      if(!confirmed&&progress.advancing(video.currentTime)){confirmed=true;runtime.mediaStage(id,'frames_advancing');runtime.visible(object.id,object.asset.id);}
      schedule();
    };
    if(reduced)schedule();
    else {runtime.mediaStage(id,'play_requested');void playVideo(video,signal.signal).then(()=>{if(stopped)return;runtime.mediaStage(id,'play_started');watchdog=setTimeout(()=>fail('video_frame_stalled'),4000);schedule();}).catch(error=>fail(error instanceof Error?error.message:'video_play_failed'));}
    return()=>{stopped=true;signal.abort();clearTimeout(watchdog);if('cancelVideoFrameCallback' in video)video.cancelVideoFrameCallback(frame);else cancelAnimationFrame(frame);video.pause();};
  },[object.asset.url,object.asset.id,object.asset.keyColor,object.id,object.eventId,runtime]);
  return <canvas style={{position:'relative'}} ref={ref} width={256} height={256} role="img" aria-label={object.asset.concept}/>;
}
function Unplaced({runtime,id,assetId}:{runtime:VisualSession;id:string;assetId:string}){
  useEffect(()=>{runtime.placementFailed(id,assetId);},[runtime,id,assetId]);return null;
}
export function VisualStage({runtime,snapshot,stage}:{runtime:VisualSession;snapshot:VisualSnapshot;stage:RefObject<VrmStageHandle|null>}){
  const root=useRef<HTMLDivElement>(null);const {layout}=useWorldLayout(root,stage,runtime);const occupied:WorldRect[]=[];
  const placement=(scale:number,aspect=1)=>{for(const shrink of [1,.8,.6,.45])for(const anchor of [{x:.84,y:.55},{x:.16,y:.55},{x:.84,y:.32},{x:.16,y:.32},{x:.84,y:.73},{x:.16,y:.73},{x:.5,y:.68},{x:.38,y:.73},{x:.62,y:.73}]){
    const p=placeWorldProp(layout,anchor,{bounds:{x:0,y:0,width:1,height:1},pivot:{x:.5,y:.5},aspect,displayWidth:.32,maxWidth:.45,shrinkSteps:[1]},scale*shrink,occupied);if(p){occupied.push(p.visible);return p.rect;}}
    return null;};
  const style=(r:WorldRect)=>({left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});
  return <>
    {snapshot.ready?.filter(o=>o.id==='background').map(o=><img key={o.asset.id} className="visual-background" src={o.asset.url} alt="" onLoad={()=>runtime.visible('background',o.asset.id)}/>)}
    {snapshot.background&&<img className="visual-background" src={snapshot.background.asset.url} alt="" onLoad={()=>runtime.visible('background',snapshot.background!.asset.id)}/>}
    <div className="visual-layer" ref={root}>
      {[...snapshot.objects.filter(o=>!snapshot.ready?.some(r=>r.id===o.id)),...(snapshot.ready??[]).filter(o=>o.id!=='background')].sort((a,b)=>b.at-a.at).slice(0,3).map((object,index)=>{
        const age=snapshot.now-object.at,rect=placement((index===0?1:.7)*(age>=30000?.6:age>=15000?.8:1)*(object.effects.includes('grow')?1.4:1),object.asset.width&&object.asset.height?object.asset.width/object.asset.height:1);
        if(!rect)return object.visible?null:<Unplaced key={object.id} id={object.id} assetId={object.asset.id} runtime={runtime}/>;
        return <div key={object.id} className={'visual-object '+object.effects.map(e=>'visual-effect-'+e).join(' ')} style={{...style(rect),opacity:age>=30000?.4:1}}>
          {object.asset.kind==='video'&&!object.visible&&object.asset.source&&<img style={{position:'absolute',inset:0}} src={object.asset.source.url} alt=""/>}
          {object.asset.kind==='video'?<VisualVideo object={object} runtime={runtime}/>:<img src={object.asset.url} alt={object.asset.concept} onLoad={()=>runtime.visible(object.id,object.asset.id)}/>}
        </div>;
      })}
      {snapshot.pending.filter(j=>j.intent.type==='prop'&&!snapshot.objects.some(o=>o.id===j.target)).slice(0,3).map(job=>{
        const rect=placement(.7);return rect?<div key={job.id} className="visual-presence" style={style(rect)} role="status" aria-label="何かが現れようとしています">✧</div>:null;
      })}
    </div>
  </>;
}
