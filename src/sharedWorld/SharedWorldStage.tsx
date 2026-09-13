import { useEffect, useRef, useState, type CSSProperties, type RefObject, type ReactNode } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import { useWorldLayout } from '../world/useWorldLayout';
import { overlaps, type WorldRect } from '../world/worldLayout';
import { placeVisualProp } from '../visual/placement';
import { cardPool } from '../cards/cardPool';
import { worldCardMeaning } from './cards';
import { elementStage, traceWeight, worldSpriteGroups, type WorldElement } from './state';
import type { SharedWorldClient } from './useSharedWorld';
import './sharedWorld.css';
const layoutSink={setLayout:()=>{}};
function Sprite({element,onDisplayed,background=false}:{element:WorldElement;onDisplayed:()=>void;background?:boolean}){
  const [loaded,setLoaded]=useState<string|null>(null);
  useEffect(()=>{if(!element.assetUrl||loaded===element.assetUrl)onDisplayed();},[element.assetUrl,loaded,onDisplayed]);
  const card=cardPool.find(c=>c.id===element.sourceCardIds[0]);
  return element.assetUrl?<img className={background?'shared-world-background':undefined} src={element.assetUrl} alt={element.concept} onLoad={()=>setLoaded(element.assetUrl!)}/>:<span role="img" aria-label={element.concept}>{card?worldCardMeaning(card).icon:'✧'}</span>;
}
export function SharedWorldStage({world,stage}:{world:SharedWorldClient;stage:RefObject<VrmStageHandle|null>}){
  const root=useRef<HTMLDivElement>(null);const {layout}=useWorldLayout(root,stage,layoutSink);
  const [localNow,setNow]=useState(Date.now);const [pointer,setPointer]=useState({x:-100,y:-100,until:0});
  const acknowledgements=useRef(new Map<string,number>());
  const [geometry,setGeometry]=useState<{bounds:{x:number;y:number;width:number;height:number}|null;protectedRects:WorldRect[]}>({bounds:null,protectedRects:[]});
  useEffect(()=>{const timer=setInterval(()=>{
    setNow(Date.now());const bounds=root.current?.getBoundingClientRect();if(!bounds)return;
    const protectedRects=Array.from(document.querySelectorAll<HTMLElement>('.reply, .subtitle, .subtitle-overlay, .speech-caption, .performer-caption, .public-controls__actions, [aria-label="緊急停止"]')).map(node=>{const r=node.getBoundingClientRect();return {x:(r.x-bounds.x)/bounds.width,y:(r.y-bounds.y)/bounds.height,width:r.width/bounds.width,height:r.height/bounds.height};});
    setGeometry({bounds:{x:bounds.x,y:bounds.y,width:bounds.width,height:bounds.height},protectedRects});
  },250);return()=>clearInterval(timer);},[]);
  useEffect(()=>{
    const point=(e:PointerEvent)=>setPointer({x:e.clientX,y:e.clientY,until:Date.now()+900});
    const focus=(e:FocusEvent)=>{if(e.target instanceof HTMLElement){const r=e.target.getBoundingClientRect();setPointer({x:r.x+r.width/2,y:r.y+r.height/2,until:Date.now()+3000});}};
    document.addEventListener('pointerdown',point);document.addEventListener('pointermove',point);document.addEventListener('focusin',focus);
    return()=>{document.removeEventListener('pointerdown',point);document.removeEventListener('pointermove',point);document.removeEventListener('focusin',focus);};
  },[]);
  const state=world.snapshot;if(!state)return null;
  const now=localNow+state.serverNow-(state.receivedAt??state.serverNow);
  const resetting=state.resetUntil>now;const chaos=!!state.chaos&&now-state.chaos.at<10000;
  const source=resetting?world.sweepElements:state.elements;
  const visible=source.filter(e=>e.status==='ready'||e.status==='displayed').sort((a,b)=>b.reinforcedAt-a.reinforcedAt);
  const displayed=(e:WorldElement)=>{
    const key=`${state.epoch}:${e.id}`;
    if(resetting||e.status!=='ready'||(acknowledgements.current.get(key)??0)>localNow)return;
    acknowledgements.current.set(key,Infinity);
    void world.displayed(e.id).finally(()=>acknowledgements.current.set(key,Date.now()+2000));
  };
  const occupied:WorldRect[]=[];
  const {bounds,protectedRects}=geometry;
  return <>
    {visible.filter(e=>e.kind==='background'&&elementStage(e,now)!=='trace').slice(0,1).map(e=>e.assetUrl&&<Sprite key={e.id} element={e} background onDisplayed={()=>displayed(e)}/>)}
    <div ref={root} className={`shared-world-layer ${chaos?'chaos':''} ${resetting?'sweeping':''}`} aria-label="共有世界の小物">
      {worldSpriteGroups(visible,now,chaos).flatMap(({element,phase,copies},group)=>{
        const background=phase!=='foreground';
        return Array.from({length:Math.max(0,copies)},(_,i)=>{
          let rect:WorldRect|null;
          if(background)rect={x:((group*.17+i*.23)% .88),y:.72+(group%3)*.07,width:.06,height:.07};
          else if(chaos)rect={x:((i*37+group*13)%90)/100,y:((i*23+group*7)%78)/100,width:.09,height:.12};
          else rect=placeVisualProp(layout,false,.35,1,occupied);
          if(!rect||protectedRects.some(r=>overlaps(r,rect!)))return null;if(!chaos&&!background)occupied.push(rect);
          const x=(bounds?.x??0)+(rect.x+rect.width/2)*(bounds?.width??1);const y=(bounds?.y??0)+(rect.y+rect.height/2)*(bounds?.height??1);
          const retreat=pointer.until>localNow&&Math.hypot(x-pointer.x,y-pointer.y)<150;
          const opacity=retreat?.08:phase==='trace'?Math.max(.03,.2*traceWeight(element,now)):background?.4:1;
          const style={left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`,opacity,'--delay':`${-i*.23}s`} as CSSProperties;
          const sprite:ReactNode=<Sprite element={element} onDisplayed={()=>displayed(element)}/>;
          const animated=element.effects.reduce<ReactNode>((child,e)=><div className={`world-effect world-${e}`}>{child}</div>,sprite);
          return <div className={`shared-world-sprite ${background?'distant':''}`} key={`${element.id}:${i}`} style={style}><div>{animated}</div></div>;
        });
      })}
      {chaos&&<p className="shared-world-chaos">{cardPool.find(c=>c.id===state.chaos?.cardId)?.label}群予告</p>}
      {resetting&&<p className="shared-world-chaos">🌪️ お片づけ！</p>}
    </div>
  </>;
}
