import { useEffect, useRef, useState } from 'react';
import type { Intervention } from './interventions';
import { cardPool } from '../cards/cardPool';
import { worldCardMeaning } from './cards';
import type { WorldRect } from '../world/worldLayout';

export function InterventionComments({face}:{face:WorldRect}){
  const [rows,setRows]=useState<Intervention[]>([]);const [position,setPosition]=useState<{left:number;top:number;width:number}|null>(null);
  const root=useRef<HTMLDivElement>(null);
  useEffect(()=>{const receive=(event:Event)=>setRows((event as CustomEvent<Intervention[]>).detail);
    window.addEventListener('vayria-world-interventions',receive);
    const timer=setInterval(()=>setRows(current=>current.some(r=>r.until<=Date.now())?current.filter(r=>r.until>Date.now()):current),200);
    return()=>{clearInterval(timer);window.removeEventListener('vayria-world-interventions',receive);};},[]);
  useEffect(()=>{const place=()=>{
    const width=Math.min(280,innerWidth-24),height=root.current?.offsetHeight||120;
    const obstacles=[{left:face.x*innerWidth,top:face.y*innerHeight,right:(face.x+face.width)*innerWidth,bottom:(face.y+face.height)*innerHeight},
      ...Array.from(document.querySelectorAll<HTMLElement>('.card-zone,.shared-conversation-caption,.public-controls__actions,.subtitle,.reply')).map(n=>n.getBoundingClientRect()).filter(r=>r.width&&r.height)];
    for(const left of [innerWidth-width-12,12])for(let top=12;top+height<innerHeight-12;top+=16){
      if(obstacles.every(r=>left+width<=r.left-8||left>=r.right+8||top+height<=r.top-8||top>=r.bottom+8)){setPosition({left,top,width});return;}}
    setPosition(null);
  };place();const timer=setInterval(place,250);return()=>clearInterval(timer);},[face,rows.length]);
  return <div ref={root} className="shared-interventions" style={{...position,visibility:position?'visible':'hidden'}} aria-live="off">
    {rows.map(row=>{const card=cardPool.find(c=>c.id===row.cardId);return <div className="shared-intervention" key={row.id}><span>{row.name}</span> → {card?`${worldCardMeaning(card).icon} ${card.label}`:row.cardId}{row.count>1?` ×${row.count}`:''}</div>;})}
  </div>;
}
