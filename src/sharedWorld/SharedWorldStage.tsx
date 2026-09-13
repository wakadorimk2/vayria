import { PhysicsLayer } from './PhysicsLayer';
import { useEffect, useRef, useState, type CSSProperties, type RefObject, type ReactNode } from 'react';
import type { VrmStageHandle } from '../avatar/VrmStage';
import { useWorldLayout } from '../world/useWorldLayout';
import { overlaps, type WorldRect } from '../world/worldLayout';
import { placeVisualProp } from '../visual/placement';
import { cardPool } from '../cards/cardPool';
import { worldCardMeaning, worldMatchPresentation } from './cards';
import { activeCardPhysics } from './hand';
import { elementStage, traceWeight, worldSpriteGroups, type WorldElement } from './state';
import type { SharedWorldClient } from './useSharedWorld';
import './sharedWorld.css';
const layoutSink={setLayout:()=>{}};
function Sprite({element,onDisplayed,background=false}:{element:WorldElement;onDisplayed:()=>void;background?:boolean}){
  const [loaded,setLoaded]=useState<string|null>(null);
  useEffect(()=>{if(!element.assetUrl||loaded===element.assetUrl)onDisplayed();},[element.assetUrl,loaded,onDisplayed]);
  const card=cardPool.find(c=>c.id===element.sourceCardIds[0]);
  return element.assetUrl?<img className={background?'shared-world-background':undefined} style={background&&loaded!==element.assetUrl?{visibility:'hidden'}:undefined} src={element.assetUrl} alt={element.concept} onLoad={()=>setLoaded(element.assetUrl!)}/>:<span role="img" aria-label={element.concept}>{card?worldCardMeaning(card).icon:'✧'}</span>;
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
  const physics=import.meta.env.VITE_SHARED_PHYSICS_ENABLED==='true';
  const now=localNow+state.serverNow-(state.receivedAt??state.serverNow);
  const resetting=state.resetUntil>now;
  const match=!resetting&&state.matchBonus&&now-state.matchBonus.at<8000?state.matchBonus:null;
  const matchCard=cardPool.find(c=>c.id===match?.cardId);const presentation=matchCard?worldMatchPresentation(matchCard):null;
  const chaos=!!match||!!state.chaos&&now-state.chaos.at<10000;
  const activePhysics=state.cardSlots?activeCardPhysics(state.cardSlots):state.physics??{mode:'normal' as const,effects:[]};
  const source=resetting?world.sweepElements:state.elements;
  const visible=source.filter(e=>e.status==='ready'||e.status==='displayed').sort((a,b)=>b.reinforcedAt-a.reinforcedAt);
  if(match&&matchCard&&presentation?.flock){const existing=visible.find(e=>e.kind==='prop'&&e.sourceCardIds.includes(match.cardId)&&e.assetUrl);visible.unshift({id:`match-${match.id}`,concept:worldCardMeaning(matchCard).subject,kind:'prop',status:'displayed',sourceCardIds:[match.cardId],count:32,effects:[],reinforcedAt:match.at,...(existing?.assetUrl?{assetUrl:existing.assetUrl}:{})});}
  const displayed=(e:WorldElement)=>{
    const key=`${state.epoch}:${e.id}`;
    if(resetting||e.status!=='ready'||(acknowledgements.current.get(key)??0)>localNow)return;
    acknowledgements.current.set(key,Infinity);
    void world.displayed(e.id).finally(()=>acknowledgements.current.set(key,Date.now()+2000));
  };
  const occupied:WorldRect[]=[];
  const {bounds,protectedRects}=geometry;
  return <>
    {visible.filter(e=>e.kind==='background'&&elementStage(e,now)!=='trace'&&(e.status==='displayed'||!state.desiredBackgroundId||e.id===state.desiredBackgroundId)).slice(0,2).reverse().map(e=>e.assetUrl&&<Sprite key={e.id} element={e} background onDisplayed={()=>displayed(e)}/>)}
    {match&&presentation&&<div className="shared-match-decoration" style={{'--match-hue':presentation.hue,'--match-elapsed':`${-(now-match.at)/1000}s`} as CSSProperties} aria-hidden>{Array.from({length:12},(_,i)=><span key={i} style={{left:`${(i*29+match.seed)%94}%`,top:`${(i*17+match.seed)%90}%`}}>{presentation.icon==='🃏'?presentation.label:presentation.icon}</span>)}</div>}
    <div ref={root} className={`shared-world-layer ${chaos?'chaos':''} ${resetting?'sweeping':''}`} aria-label="共有世界の小物">
      {physics&&!resetting&&<PhysicsLayer protectedRects={chaos?[]:[...protectedRects,layout.body,layout.face]} root={root} epoch={state.epoch} mode={activePhysics.mode} effects={[...activePhysics.effects,...(presentation?.effects??[])]}/>}
      {worldSpriteGroups(visible,now,chaos).flatMap(({element,phase,copies},group)=>{
        const background=phase!=='foreground';
        return Array.from({length:Math.max(0,copies)},(_,i)=>{
          let rect:WorldRect|null;
          if(background)rect={x:((group*.17+i*.23)% .88),y:.72+(group%3)*.07,width:.06,height:.07};
          else if(chaos)rect={x:((i*37+group*13)%90)/100,y:((i*23+group*7)%78)/100,width:.09,height:.12};
          else if(physics)rect={x:((i*37+group*13)%80)/100+.05,y:((i*23+group*7)%55)/100,width:.08,height:.1};
          else rect=placeVisualProp(layout,false,.35,1,occupied);
          if(!rect||(!physics||background)&&protectedRects.some(r=>overlaps(r,rect!)))return null;if(!chaos&&!background)occupied.push(rect);
          const x=(bounds?.x??0)+(rect.x+rect.width/2)*(bounds?.width??1);const y=(bounds?.y??0)+(rect.y+rect.height/2)*(bounds?.height??1);
          const retreat=pointer.until>localNow&&Math.hypot(x-pointer.x,y-pointer.y)<150;
          const opacity=retreat?.08:phase==='trace'?Math.max(.03,.2*traceWeight(element,now)):background?.4:1;
          const style={left:`${rect.x*100}%`,top:`${rect.y*100}%`,width:`${rect.width*100}%`,height:`${rect.height*100}%`,opacity,'--delay':`${-i*.23}s`} as CSSProperties;
          const sprite:ReactNode=<Sprite element={element} onDisplayed={()=>displayed(element)}/>;
          const sizeOverride=activePhysics.effects.some(e=>e==='grow'||e==='shrink');
          const intrinsic=element.effects.filter(e=>!sizeOverride||e!=='grow'&&e!=='shrink');
          const effects=[...new Set([...intrinsic,...activePhysics.effects,...(presentation?.effects??[])])];
          const animated=effects.filter(effect=>!physics||background||!['fall','dance','float','rotate','bounce','sway','slide','grow','shrink'].includes(effect)).reduce<ReactNode>((child,e)=><div className={`world-effect world-${e}`}>{child}</div>,sprite);
          return <div data-physics-id={physics&&!background&&!resetting?`${element.id}:${i}`:undefined} data-x={rect.x} data-y={rect.y} data-size={effects.includes('grow')?.14:effects.includes('shrink')?.05:.09} data-effects={JSON.stringify(element.effects)} className={`shared-world-sprite ${background?'distant':''}`} key={`${element.id}:${i}`} style={style}><div>{animated}</div></div>;
        });
      })}
      {chaos&&<p className="shared-world-chaos">{match?`${presentation?.label}、5枚揃い！`: `${cardPool.find(c=>c.id===state.chaos?.cardId)?.label}群予告`}</p>}
      {resetting&&<p className="shared-world-chaos">🌪️ お片づけ！</p>}
    </div>
  </>;
}
