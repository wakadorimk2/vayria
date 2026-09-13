import { useState, useEffect } from 'react';
import { cardPool } from '../cards/cardPool';
import { WORLD_CATEGORIES, worldCardMeaning, type WorldCategory } from './cards';
import { cardWeight, elementStage } from './state';
import type { SharedWorldClient } from './useSharedWorld';
import './sharedWorld.css';
export function WorldCards({world,compact=false,expanded,onToggle}:{world:SharedWorldClient;compact?:boolean;expanded?:boolean;onToggle?:()=>void}){
  const [category,setCategory]=useState<WorldCategory>('モノ');const [open,setOpen]=useState(!compact);
  const [localNow,setNow]=useState(Date.now);useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  const state=world.snapshot;const recent=state?.history??[];
  const now=localNow+(state?state.serverNow-(state.receivedAt??state.serverNow):0);
  const isOpen=expanded??open;
  const strongest=Object.entries(state?.weights??{}).sort((a,b)=>cardWeight(b[1],now)-cardWeight(a[1],now)).slice(0,5);
  return <section className={`shared-world-cards ${compact?'compact':''}`} aria-label="世界へカードを投入">
    {compact?<button aria-expanded={isOpen} onClick={onToggle??(()=>setOpen(!open))}>カードで、世界にいたずら</button>:<><h1>VAYRIAの部屋</h1><p>カードを入れて、みんなと世界を変えてみよう。</p></>}
    {!compact&&<div className="shared-world-summary"><h2>いまの世界</h2>{!state?.elements.length&&<p>カードの気配が集まるのを待っています。</p>}{state?.elements.slice(-6).map(e=><p key={e.id}>{cardPool.find(c=>c.id===e.sourceCardIds[0])?.label??e.concept} ×{e.count} · {e.status==='displayed'?(elementStage(e,now)==='foreground'?'世界に登場':elementStage(e,now)==='background'?'背景に残っています':'世界の痕跡'):e.status==='failed'?'今回は現れなかった':'まだ気配だけ'}</p>)}</div>}
    <div className="shared-world-brain" aria-label="いま気になるカード">{strongest.map(([id,value])=><span key={id}>{cardPool.find(c=>c.id===id)?.label} ×{value.total}</span>)}</div>
    {!compact&&<p>{state?.host&&state.host.until>now?'ヴェイリアは展示画面にいます。':'展示端末はお休み中です。カードは世界に残ります。'}</p>}
    {isOpen&&<><div className="shared-world-categories" aria-label="カードの分類">{WORLD_CATEGORIES.map(c=><button key={c} aria-pressed={c===category} onClick={()=>setCategory(c)}>{c}</button>)}</div>
      <div className="shared-world-grid">{cardPool.filter(c=>worldCardMeaning(c).category===category).map(card=><button key={card.id} disabled={!world.connected||!state?.open||state.resetUntil>now} onClick={()=>void world.insert(card.id)} aria-label={`${card.label}を投入`}><span aria-hidden>{worldCardMeaning(card).icon}</span>{card.label}</button>)}</div></>}
    <p role="status" className="shared-world-receipt">{world.error||world.receipt||(!world.connected?'接続を確認しています…':'')}</p>
    {world.role==='host'&&world.error.includes('別の展示端末')&&<button onClick={()=>void world.takeover()}>この端末へ展示を引き継ぐ</button>}
    <ol className="shared-world-history" aria-label="みんなの投入">{recent.slice(-5).reverse().map(e=><li key={e.sequence}>{e.name} → {cardPool.find(c=>c.id===e.cardId)?.label??e.cardId}</li>)}</ol>

  </section>;
}
