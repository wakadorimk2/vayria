import { cardPool } from '../cards/cardPool.js';
import { worldCardMeaning, type WorldEffect } from './cards.js';
import type { SharedWorldState } from './state.js';

export interface HandCard { id:string; cardId:string }
export interface WorldHand { epoch:number; cards:HandCard[]; boosts:Record<string,number> }
export interface WorldCardSlot { id:string; version:number; cardId:string|null; sequence:number }
export interface MatchBonus { id:string; cardId:string; at:number; seed:number }
export const WORLD_DECK = { entries:cardPool.map(card=>({cardId:card.id,weight:1})), boost:6, boostDraws:3, handSize:5 };
export function drawCard(hand:WorldHand,random=()=>crypto.getRandomValues(new Uint32Array(1))[0]/4294967296):HandCard {
  const entries=WORLD_DECK.entries.map(e=>({...e,weight:e.weight*(hand.boosts[e.cardId]>0?WORLD_DECK.boost:1)}));
  let pick=random()*entries.reduce((sum,e)=>sum+e.weight,0);let cardId=entries.at(-1)!.cardId;
  for(const entry of entries){pick-=entry.weight;if(pick<0){cardId=entry.cardId;break;}}
  for(const id of Object.keys(hand.boosts)){if(--hand.boosts[id]<=0)delete hand.boosts[id];}
  return {id:crypto.randomUUID(),cardId};
}
export function createHand(epoch:number,random?:()=>number):WorldHand {
  const hand:WorldHand={epoch,cards:[],boosts:{}};
  for(let i=0;i<WORLD_DECK.handSize;i++)hand.cards.push(drawCard(hand,random));
  return hand;
}
export function consumeHand(hand:WorldHand,id:string,random?:()=>number){
  const index=hand.cards.findIndex(c=>c.id===id);if(index<0)throw new Error('hand_card_missing');
  const used=hand.cards[index];hand.boosts[used.cardId]=WORLD_DECK.boostDraws;
  hand.cards[index]=drawCard(hand,random);return used;
}
export function matchingCard(slots:WorldCardSlot[]){return slots.length===5&&slots[0].cardId&&slots.every(s=>s.cardId===slots[0].cardId)?slots[0].cardId:null;}
export function ensureCardSlots(state:SharedWorldState){
  if(state.cardSlots)return false;
  const recent=state.history.slice(-5);
  state.cardSlots=Array.from({length:5},(_,i)=>({id:`slot-${i}`,version:0,cardId:recent[i]?.cardId??null,sequence:recent[i]?.sequence??0}));
  for(const element of state.elements){
    const derived=new Set(element.sourceCardIds.flatMap(id=>{const card=cardPool.find(c=>c.id===id);return card?worldCardMeaning(card).effects:[];}));
    element.effects=element.effects.filter(effect=>!derived.has(effect)||effect==='multiply');
  }
  state.matchingCardId=matchingCard(state.cardSlots);return true;
}
export function activeCardPhysics(slots:WorldCardSlot[]){
  let mode:'normal'|'water'|'zero'='normal';let size:WorldEffect|undefined;
  const effects=new Set<WorldEffect>();
  for(const slot of [...slots].sort((a,b)=>a.sequence-b.sequence)){
    const card=cardPool.find(c=>c.id===slot.cardId);if(!card)continue;
    if(['zero-gravity','space'].includes(card.id))mode='zero';
    if(card.id==='underwater')mode='water';
    for(const effect of worldCardMeaning(card).effects){
      if(effect==='grow'||effect==='shrink')size=effect;
      else if(effect!=='multiply'&&!(effect==='float'&&['zero-gravity','space','underwater'].includes(card.id)))effects.add(effect);
    }
  }
  if(size)effects.add(size);
  return {mode,effects:[...effects]};
}
export function updateCardSlot(state:SharedWorldState,slot:WorldCardSlot,cardId:string,eventId:string,now:number){
  slot.cardId=cardId;slot.version++;slot.sequence=state.sequence;
  const match=matchingCard(state.cardSlots!);
  if(match&&match!==state.matchingCardId&&(!state.matchBonus||now-state.matchBonus.at>=60000)){
    state.matchBonus={id:eventId,cardId:match,at:now,seed:state.sequence};
    const card=cardPool.find(c=>c.id===match)!;
    state.outcomes=[...state.outcomes,`${card.label}が共有5枠に揃った。8秒間の揃い演出が発生した。`].slice(-12);
  }
  state.matchingCardId=match;
}
