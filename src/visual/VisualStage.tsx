import { useEffect, useRef, type RefObject } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import { useWorldLayout } from '../world/useWorldLayout';
import { placeWorldProp, type WorldRect } from '../world/worldLayout';
import { preparedVideos, keyGreen } from '../manifestation/media';
import type { VisualObject, VisualSession, VisualSnapshot } from './session';
import './visual.css';
function VisualVideo({object,runtime}:{object:VisualObject;runtime:VisualSession}){
  const ref=useRef<HTMLCanvasElement>(null);
  useEffect(()=>{
    const video=preparedVideos.get(object.asset.url),ctx=ref.current?.getContext('2d',{willReadFrequently:true});if(!video||!ctx)return;
    const reduced=matchMedia('(prefers-reduced-motion: reduce)').matches;let frame=0;
    const draw=()=>{ctx.drawImage(video,0,0,256,256);const image=ctx.getImageData(0,0,256,256);keyGreen(image.data);ctx.putImageData(image,0,0);runtime.visible(object.id);if(!reduced)frame=requestAnimationFrame(draw);};
    if(!reduced)void video.play().catch(()=>{});frame=requestAnimationFrame(draw);
    return()=>{cancelAnimationFrame(frame);video.pause();};
  },[object.asset.url,object.id,runtime]);
  return <canvas ref={ref} width={256} height={256} role="img" aria-label={object.asset.concept}/>;
}
export function VisualStage({runtime,snapshot,stage}:{runtime:VisualSession;snapshot:VisualSnapshot;stage:RefObject<VrmStageHandle|null>}){
  const root=useRef<HTMLDivElement>(null);const {layout}=useWorldLayout(root,stage,runtime);const occupied:WorldRect[]=[];
  const placement=(scale:number)=>{for(const anchor of [{x:.84,y:.55},{x:.16,y:.55},{x:.84,y:.32},{x:.16,y:.32},{x:.84,y:.73},{x:.16,y:.73}]){
    const p=placeWorldProp(layout,anchor,{bounds:{x:0,y:0,width:1,height:1},pivot:{x:.5,y:.5},aspect:1,displayWidth:.22},scale,occupied);if(p){occupied.push(p.visible);return p.rect;}}
    return null;};
  const style=(r:WorldRect)=>({left:`${r.x*100}%`,top:`${r.y*100}%`,width:`${r.width*100}%`,height:`${r.height*100}%`});
  return <>
    {snapshot.background&&<img className="visual-background" src={snapshot.background.asset.url} alt="" onLoad={()=>runtime.visible('background')}/>}
    <div className="visual-layer" ref={root}>
      {[...snapshot.objects].sort((a,b)=>b.at-a.at).map((object,index)=>{
        const age=snapshot.now-object.at,rect=placement((index===0?1:.7)*(age>=30000?.6:age>=15000?.8:1)*(object.effects.includes('grow')?1.4:1));
        if(!rect)return null;
        return <div key={object.id} className={'visual-object '+object.effects.map(e=>'visual-effect-'+e).join(' ')} style={{...style(rect),opacity:age>=30000?.4:1}}>
          {object.asset.kind==='video'?<VisualVideo object={object} runtime={runtime}/>:<img src={object.asset.url} alt={object.asset.concept} onLoad={()=>runtime.visible(object.id)}/>}
        </div>;
      })}
      {snapshot.pending.filter(j=>j.intent.type==='prop'&&!snapshot.objects.some(o=>o.id===j.target)).slice(0,3).map(job=>{
        const rect=placement(.7);return rect?<div key={job.id} className="visual-presence" style={style(rect)} role="status" aria-label="何かが現れようとしています">✧</div>:null;
      })}
    </div>
  </>;
}
