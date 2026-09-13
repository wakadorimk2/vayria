import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { WildcardCard } from '../cards/WildcardCard';
import { cardPool } from '../cards/cardPool';
import type { SharedWorldClient } from './useSharedWorld';
import type { WorldCardSlot } from './hand';

export function SharedHandCards({world}:{world:SharedWorldClient}){
  const [selected,setSelected]=useState<string|null>(null);
  const [pending,setPending]=useState<string|null>(null);
  const [ghost,setGhost]=useState<{id:string;x:number;y:number}|null>(null);
  const [target,setTarget]=useState<string|null>(null);
  const drag=useRef<{id:string;x:number;y:number;moving:boolean}|null>(null);
  const suppressClick=useRef(false);const root=useRef<HTMLDivElement>(null);
  const state=world.snapshot;const hand=state?.hand??[];const slots=state?.cardSlots??[];
  const blocked=!!pending||!world.connected||!state?.open||state.resetUntil>state.serverNow;
  const commit=async(id:string,slot:WorldCardSlot)=>{
    if(blocked)return;
    const focusIndex=hand.findIndex(c=>c.id===id);
    setPending(id);const accepted=await world.insertHand(id,slot,`${id}-${slot.id}-${slot.version}`);
    setPending(null);if(accepted){setSelected(null);setTimeout(()=>root.current?.querySelectorAll<HTMLElement>('[data-hand-card] [role="button"]')[focusIndex]?.focus(),0);}
  };
  const latest=useRef({slots,commit,blocked});
  useEffect(()=>{latest.current={slots,commit,blocked};});
  useEffect(()=>{
    const finish=()=>{drag.current=null;setGhost(null);setTarget(null);};
    const move=(event:globalThis.PointerEvent)=>{const d=drag.current;if(!d)return;
      if(!d.moving&&Math.hypot(event.clientX-d.x,event.clientY-d.y)<6)return;
      event.preventDefault();d.moving=true;setGhost({id:d.id,x:event.clientX,y:event.clientY});
      const node=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-world-slot]');
      setTarget(node&&root.current?.contains(node)?node.dataset.worldSlot??null:null);
    };
    const up=(event:globalThis.PointerEvent)=>{const d=drag.current;if(!d)return;
      if(d.moving){suppressClick.current=true;
        const node=document.elementFromPoint(event.clientX,event.clientY)?.closest<HTMLElement>('[data-world-slot]');
        const slot=latest.current.slots.find(s=>s.id===node?.dataset.worldSlot);
        if(slot&&node&&root.current?.contains(node))void latest.current.commit(d.id,slot);
        setTimeout(()=>{suppressClick.current=false;},0);
      }finish();
    };
    window.addEventListener('pointermove',move,{passive:false});window.addEventListener('pointerup',up);window.addEventListener('pointercancel',finish);window.addEventListener('blur',finish);
    return()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',up);window.removeEventListener('pointercancel',finish);window.removeEventListener('blur',finish);};
  },[]);
  const pointerDown=(id:string,event:PointerEvent<HTMLElement>)=>{if(blocked||event.button!==0)return;drag.current={id,x:event.clientX,y:event.clientY,moving:false};};
  const selectedId=hand.some(c=>c.id===selected)?selected:null;
  const ghostCard=cardPool.find(c=>c.id===hand.find(h=>h.id===ghost?.id)?.cardId);
  return <div ref={root} className="card-prototype shared-hand-cards" aria-label="共有状態とあなたの手札">
    <section className="card-zone card-zone--brain" aria-label="全員で共有する5枠"><h2>みんなの状態</h2>
      <div className="card-zone__cards">{slots.map((slot,index)=>{const card=cardPool.find(c=>c.id===slot.cardId);return <div key={slot.id} data-world-slot={slot.id} className={target===slot.id?'shared-slot shared-slot--target':'shared-slot'} aria-label={`状態の枠${index+1}`}>
        {card?<WildcardCard card={card} state={target===slot.id?'selected':'normal'} interactionDisabled={blocked||!selectedId} onSelect={()=>{if(selectedId)void commit(selectedId,slot);}}/>:<button className="shared-slot-empty" disabled={blocked||!selectedId} onClick={()=>{if(selectedId)void commit(selectedId,slot);}} aria-label={`空の枠${index+1}へ差し込む`}>＋</button>}
      </div>;})}</div>
    </section>
    <p className="shared-hand-hint" role="status">{pending?'カードを差し込んでいます…':selectedId?'差し込む枠を選んでください':'手札をドラッグ、または手札と枠を順にタップ'}</p>
    <section className="card-zone card-zone--hand" aria-label="あなたの手札5枚"><h2>あなたの手札</h2><div className="card-zone__cards">{hand.map(item=>{const card=cardPool.find(c=>c.id===item.cardId)!;return <div key={item.id} className="shared-hand-card" data-hand-card={item.id} aria-busy={pending===item.id}>
      <WildcardCard card={card} pendingLabel="、受付中" interactionDisabled={blocked} state={selectedId===item.id?'selected':'normal'} motion={pending===item.id?'pending-insertion':ghost?.id===item.id?'dragging':'none'} onPointerDown={event=>pointerDown(item.id,event)} onSelect={()=>{if(!suppressClick.current)setSelected(selectedId===item.id?null:item.id);}}/>
    </div>;})}</div></section>
    {ghost&&ghostCard&&<div className="shared-hand-ghost" style={{left:ghost.x,top:ghost.y}} aria-hidden><WildcardCard card={ghostCard}/></div>}
  </div>;
}
