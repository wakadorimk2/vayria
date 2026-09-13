import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { WildcardCard } from '../cards/WildcardCard';
import { CardSurface, BrainCardFrame } from '../cards/CardSurface';
import { resolveCardDropPreview, resolveCommittedCardDropTarget, resolveCardDragPlacement, type CardDropPreview, type CardDropPreviewLayout } from '../cards/cardDropPreview';
import { cardPool } from '../cards/cardPool';
import type { SharedWorldClient } from './useSharedWorld';
import type { WorldCardSlot } from './hand';

export function SharedHandCards({world}:{world:SharedWorldClient}){
  const [selected,setSelected]=useState<string|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const [ghost,setGhost]=useState<{id:string;x:number;y:number;width:number;height:number}|null>(null);
  const [preview,setPreview]=useState<CardDropPreview|null>(null);
  const [inserted,setInserted]=useState<string|null>(null);
  const drag=useRef<{id:string;x:number;y:number;moving:boolean;offsetX:number;offsetY:number;width:number;height:number;layout:CardDropPreviewLayout;preview:CardDropPreview|null}|null>(null);
  const suppressClick=useRef(false);const root=useRef<HTMLDivElement>(null);
  const state=world.snapshot;const hand=state?.hand??[];const slots=state?.cardSlots??[];
  const blocked=!!pending||!world.connected||!state?.open||state.resetUntil>state.serverNow;
  const commit=async(id:string,slot:WorldCardSlot)=>{
    if(blocked)return;
    const focusIndex=hand.findIndex(c=>c.id===id);
    setPending(id);const accepted=await world.insertHand(id,slot,`${id}-${slot.id}-${slot.version}`);
    setPending(null);if(accepted){setSelected(null);setInserted(slot.id);setTimeout(()=>setInserted(null),600);setTimeout(()=>root.current?.querySelectorAll<HTMLElement>('[data-hand-card]')[focusIndex]?.focus(),0);}
  };
  const latest=useRef({slots,commit,blocked});
  useEffect(()=>{latest.current={slots,commit,blocked};});
  useEffect(()=>{
    const finish=()=>{drag.current=null;setGhost(null);setPreview(null);};
    const move=(event:globalThis.PointerEvent)=>{const d=drag.current;if(!d)return;
      if(!d.moving&&Math.hypot(event.clientX-d.x,event.clientY-d.y)<6)return;
      event.preventDefault();d.moving=true;const placement=resolveCardDragPlacement({...d,pointerX:event.clientX,pointerY:event.clientY});
      setGhost({id:d.id,x:placement.left,y:placement.top,width:d.width,height:d.height});
      d.preview=resolveCardDropPreview(d.layout,{pointerX:event.clientX,dragTop:placement.top,dragBottom:placement.top+d.height},d.preview);setPreview(d.preview);
    };
    const up=(event:globalThis.PointerEvent)=>{const d=drag.current;if(!d)return;
      if(d.moving){suppressClick.current=true;
        const placement=resolveCardDragPlacement({...d,pointerX:event.clientX,pointerY:event.clientY});
        const final=resolveCardDropPreview(d.layout,{pointerX:event.clientX,dragTop:placement.top,dragBottom:placement.top+d.height},d.preview);
        const slot=latest.current.slots.find(s=>s.id===resolveCommittedCardDropTarget(d.preview,final));
        if(slot)void latest.current.commit(d.id,slot);
        setTimeout(()=>{suppressClick.current=false;},0);
      }finish();
    };
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',finish);window.addEventListener('blur',finish);
    return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',finish);window.removeEventListener('blur',finish);};
  },[]);
  const pointerDown=(id:string,event:PointerEvent<HTMLElement>)=>{
    if(blocked||event.button!==0||drag.current)return;
    const rect=event.currentTarget.getBoundingClientRect();
    const cards=Array.from(root.current?.querySelectorAll<HTMLElement>('[data-world-slot]')??[]).map(node=>{const r=node.getBoundingClientRect();return {id:node.dataset.worldSlot!,centerX:r.x+r.width/2,centerY:r.y+r.height/2,width:r.width,height:r.height};});
    if(!cards.length)return;
    const layout={cards,left:Math.min(...cards.map(c=>c.centerX-c.width/2)),right:Math.max(...cards.map(c=>c.centerX+c.width/2)),top:Math.min(...cards.map(c=>c.centerY-c.height/2)),bottom:Math.max(...cards.map(c=>c.centerY+c.height/2))};
    drag.current={id,x:event.clientX,y:event.clientY,moving:false,offsetX:event.clientX-rect.x,offsetY:event.clientY-rect.y,width:rect.width,height:rect.height,layout,preview:null};
  };
  const selectedId=hand.some(c=>c.id===selected)?selected:null;
  const ghostCard=cardPool.find(c=>c.id===hand.find(h=>h.id===ghost?.id)?.cardId);
  return <div ref={root} className="card-prototype shared-hand-cards" aria-label="共有状態とあなたの手札">
    <section className="card-zone card-zone--brain" aria-label="全員で共有する5枠" data-selection-target={!!selectedId||!!ghost}><header className="card-zone__header"><h2>みんなの状態</h2></header>
      <div className="card-zone__cards">{slots.map((slot,index)=>{const card=cardPool.find(c=>c.id===slot.cardId);const target=preview?.targetCardId===slot.id;return <BrainCardFrame key={slot.id} slotId={slot.id} preview={target?preview:null}>
        {card?<CardSurface zone="brain" index={index} card={card} motion={target?'drop-target':inserted===slot.id?'inserted':'none'} interactionDisabled={blocked||!selectedId} onSelect={()=>{if(selectedId)void commit(selectedId,slot);}}/>:<button className="shared-slot-empty" disabled={blocked||!selectedId} onClick={()=>{if(selectedId)void commit(selectedId,slot);}} aria-label={`空の枠${index+1}へ差し込む`}>＋</button>}
      </BrainCardFrame>;})}</div>
    </section>
    <section className="card-zone card-zone--hand" aria-label="あなたの手札5枚"><div className="card-zone__cards">{hand.map((item,index)=>{const card=cardPool.find(c=>c.id===item.cardId)!;return <CardSurface key={item.id} instanceId={item.id} zone="hand" index={index} card={card} pendingLabel="、受付中" interactionDisabled={blocked} state={selectedId===item.id?'selected':'normal'} motion={pending===item.id?'pending-insertion':ghost?.id===item.id?'dragging':'none'} onPointerDown={event=>pointerDown(item.id,event)} onSelect={()=>{if(!suppressClick.current)setSelected(selectedId===item.id?null:item.id);}}/>;})}</div>
    <div className="card-zone__action" role="status">{pending?'カードを差し込んでいます…':selectedId?'差し込む枠を選んでください':'手札をドラッグ、または手札と枠を順にタップ'}</div></section>
    {ghost&&ghostCard&&<div className="shared-hand-ghost" style={{left:ghost.x,top:ghost.y,width:ghost.width,height:ghost.height}} aria-hidden><WildcardCard card={ghostCard}/></div>}
  </div>;
}
