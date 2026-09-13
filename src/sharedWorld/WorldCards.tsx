import { useState, useEffect } from 'react';
import { cardPool } from '../cards/cardPool';
import { WORLD_CATEGORIES, worldCardMeaning, type WorldCategory } from './cards';
import type { SharedWorldClient } from './useSharedWorld';
import './sharedWorld.css';
import { SharedHandCards } from './SharedHandCards';
export function WorldCards({world,compact=false,expanded,onToggle}:{world:SharedWorldClient;compact?:boolean;expanded?:boolean;onToggle?:()=>void}){
  const [category,setCategory]=useState<WorldCategory>('モノ');const [open,setOpen]=useState(!compact);
  const [localNow,setNow]=useState(Date.now);useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
  useEffect(()=>{if(!compact||!expanded||!onToggle)return;const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();onToggle();document.querySelector<HTMLElement>('.public-controls__cards')?.focus();}};document.addEventListener('keydown',key);return()=>document.removeEventListener('keydown',key);},[compact,expanded,onToggle]);
  const state=world.snapshot;
  const now=localNow+(state?state.serverNow-(state.receivedAt??state.serverNow):0);
  const isOpen=expanded??open;
  if(compact&&!isOpen)return null;
  if(state?.cardSlots)return <section id="shared-world-card-panel" className="shared-world-cards shared-card-table" aria-label="世界へカードを投入">
    <button aria-label="カード一覧を閉じる" onClick={()=>{onToggle?.();document.querySelector<HTMLElement>('.public-controls__cards')?.focus();}}>閉じる</button>
    <SharedHandCards world={world}/>
    <p role="status" className="shared-world-receipt">{world.error||world.receipt||(!world.connected?'接続を確認しています…':'')}</p>
  </section>;
  return <section id="shared-world-card-panel" className={`shared-world-cards ${compact?'compact':''}`} aria-label="世界へカードを投入">
    {compact?<button aria-label="カード一覧を閉じる" onClick={()=>{if(onToggle)onToggle();else setOpen(!open);document.querySelector<HTMLElement>('.public-controls__cards')?.focus();}}>閉じる</button>:<><h1>VAYRIAの部屋</h1><p>カードを入れて、みんなと世界を変えてみよう。</p></>}
    {!compact&&!state?.sharedConversation&&<p>{state?.host&&state.host.until>now?'ヴェイリアは展示画面にいます。':'展示端末はお休み中です。カードは世界に残ります。'}</p>}
    {isOpen&&<><div className="shared-world-categories" aria-label="カードの分類">{WORLD_CATEGORIES.map(c=><button key={c} aria-pressed={c===category} onClick={()=>setCategory(c)}>{c}</button>)}</div>
      <div className="shared-world-grid">{cardPool.filter(c=>worldCardMeaning(c).category===category).map(card=><button key={card.id} disabled={!world.connected||!state?.open||state.resetUntil>now} onClick={()=>void world.insert(card.id)} aria-label={`${card.label}を投入`}><span aria-hidden>{worldCardMeaning(card).icon}</span>{card.label}</button>)}</div></>}
    <p role="status" className="shared-world-receipt">{world.error||world.receipt||(!world.connected?'接続を確認しています…':'')}</p>
    {world.role==='host'&&world.error.includes('別の展示端末')&&<button onClick={()=>void world.takeover()}>この端末へ展示を引き継ぐ</button>}

  </section>;
}
