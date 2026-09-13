import { cardPool } from '../cards/cardPool.js';
import { initialWorld, type WorldState } from '../world/worldState.js';
import { WORLD_EFFECTS, worldCardMeaning, type WorldEffect } from './cards.js';

export const WORLD_DEFAULTS = { halfLife:180000, foregroundMs:180000, backgroundMs:1800000, traceHalfLife:86400000,
  foregroundLimit:24, chaosLimit:96, backgroundLimit:6, historyLimit:10000, threshold:10, windowMs:30000, leaseMs:30000 };
export type WorldIntent = { actions: { type:'prop'|'background'|'effect'|'duplicate'; targetId:string; concept:string;
  sourceCardIds:string[]; effects:WorldEffect[]; count:number }[] };
export interface WorldElement { id:string; concept:string; sourceCardIds:string[]; effects:WorldEffect[]; count:number;
  kind:'prop'|'background'; reinforcedAt:number; status:'preparing'|'ready'|'displayed'|'failed'; requestedAt?:number; assetUrl?:string; error?:string }
export interface WorldInput { eventId:string; participant:string; name:string; cardId:string; at:number; sequence:number }
export interface SharedWorldState {
  schemaVersion:1; roomId:string; epoch:number; revision:number; sequence:number; open:boolean;
  weights:Record<string,{value:number;at:number;total:number}>; history:WorldInput[]; daily:Record<string,Record<string,number>>;
  elements:WorldElement[]; displayedWorld:WorldState; outcomes:string[];
  chaos:{id:string;cardId:string;at:number;count:number}|null;
  resetUntil:number; host:{clientId:string;visitor:string;token:string;until:number}|null;
  lastDecisionAt:number; decisions:string[];
}
export class WorldError extends Error { constructor(public code:string, public status=409){super(code);} }
export const validId=(x:unknown):x is string=>typeof x==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(x);
export function createSharedWorld(roomId:string):SharedWorldState {
  return {schemaVersion:1,roomId,epoch:0,revision:0,sequence:0,open:true,weights:{},history:[],daily:{},elements:[],
    displayedWorld:initialWorld(),outcomes:[],chaos:null,resetUntil:0,host:null,lastDecisionAt:0,decisions:[]};
}
export function cardWeight(entry:{value:number;at:number},now:number){return entry.value*2**(-Math.max(0,now-entry.at)/WORLD_DEFAULTS.halfLife);}
export function elementStage(element:WorldElement,now:number){const age=Math.max(0,now-element.reinforcedAt);return age<WORLD_DEFAULTS.foregroundMs?'foreground':age<WORLD_DEFAULTS.backgroundMs?'background':'trace';}
export function traceWeight(element:WorldElement,now:number){return 2**(-Math.max(0,now-element.reinforcedAt-WORLD_DEFAULTS.backgroundMs)/WORLD_DEFAULTS.traceHalfLife);}
export function worldSpriteGroups(elements:WorldElement[],now:number,chaos:boolean){
  let foreground=0,backgrounds=0;const limit=chaos?WORLD_DEFAULTS.chaosLimit:WORLD_DEFAULTS.foregroundLimit;
  return elements.filter(e=>e.kind==='prop').flatMap(element=>{
    const natural=elementStage(element,now);const phase=natural==='foreground'&&foreground>=limit?'background':natural;
    if(phase!=='foreground'){if(backgrounds++>=WORLD_DEFAULTS.backgroundLimit)return [];return [{element,phase,copies:Math.min(3,element.count)}];}
    const copies=Math.min(element.count,limit-foreground);foreground+=copies;return [{element,phase,copies}];
  });
}
export function insertWorldCard(state:SharedWorldState,input:Omit<WorldInput,'at'|'sequence'>,now:number){
  if(!state.open||state.resetUntil>now)throw new WorldError('room_closed');
  if(!validId(input.eventId)||!cardPool.some(c=>c.id===input.cardId))throw new WorldError('invalid_card',400);
  const duplicate=state.history.find(e=>e.eventId===input.eventId&&e.participant===input.participant);if(duplicate)return duplicate;
  const old=state.weights[input.cardId];state.weights[input.cardId]={value:(old?cardWeight(old,now):0)+1,at:now,total:(old?.total??0)+1};
  const event={...input,at:now,sequence:++state.sequence};state.history.push(event);state.revision++;
  while(state.history.length>WORLD_DEFAULTS.historyLimit){const e=state.history.shift()!;const day=new Date(e.at).toISOString().slice(0,10);const totals=state.daily[day]??={};totals[e.cardId]=(totals[e.cardId]??0)+1;}
  const count=state.history.filter(e=>e.cardId===input.cardId&&e.at>now-WORLD_DEFAULTS.windowMs).length;
  const card=cardPool.find(c=>c.id===input.cardId)!;
  if(worldCardMeaning(card).category==='モノ'&&count>=WORLD_DEFAULTS.threshold){
    if(!state.chaos||now-state.chaos.at>=WORLD_DEFAULTS.windowMs){
      state.chaos={id:event.eventId,cardId:card.id,at:now,count};
      const id=`flock-${card.id}`;const existing=state.elements.find(e=>e.id===id);
      const flock:WorldElement=existing??{id,concept:worldCardMeaning(card).subject,sourceCardIds:[card.id],kind:'prop',effects:['fall'],count,status:'ready',reinforcedAt:now};
      Object.assign(flock,{count,reinforcedAt:now,status:'ready'});if(!existing)state.elements.push(flock);
      state.outcomes=[...state.outcomes,`${card.label}の群れの予告が発生した。表示確定を待つ。`].slice(-12);
    }else if(state.chaos.cardId===card.id){state.chaos.count=count;const flock=state.elements.find(e=>e.id===`flock-${card.id}`);if(flock)flock.count=count;}
  }
  return event;
}
export function readWorldIntent(value:unknown):WorldIntent|null{
  if(!value||typeof value!=='object'||!('actions' in value)||!Array.isArray(value.actions)||value.actions.length>4)return null;
  const actions:WorldIntent['actions']=[];
  for(const a of value.actions){if(!a||!['prop','background','effect','duplicate'].includes(a.type)||typeof a.targetId!=='string'||(a.targetId!==''&&!validId(a.targetId))||typeof a.concept!=='string'||a.concept.length>160||!Array.isArray(a.sourceCardIds)||!a.sourceCardIds.length||a.sourceCardIds.length>8||!a.sourceCardIds.every((id:unknown)=>typeof id==='string'&&cardPool.some(c=>c.id===id))||!Array.isArray(a.effects)||a.effects.length>6||!a.effects.every((e:WorldEffect)=>WORLD_EFFECTS.includes(e))||!Number.isInteger(a.count)||a.count<1||a.count>1000)return null;
    actions.push({type:a.type,targetId:a.targetId,concept:a.concept,sourceCardIds:[...new Set<string>(a.sourceCardIds)],effects:a.effects,count:a.count});}
  return {actions};
}
export const worldIntentSchema={type:'object',additionalProperties:false,properties:{actions:{type:'array',maxItems:4,items:{type:'object',additionalProperties:false,
  properties:{type:{type:'string',enum:['prop','background','effect','duplicate']},targetId:{type:'string'},concept:{type:'string'},sourceCardIds:{type:'array',items:{type:'string',enum:cardPool.map(c=>c.id)},minItems:1,maxItems:8},effects:{type:'array',items:{type:'string',enum:WORLD_EFFECTS},maxItems:6},count:{type:'integer',minimum:1,maximum:1000}},required:['type','targetId','concept','sourceCardIds','effects','count']}}},required:['actions']};
export function applyWorldIntent(state:SharedWorldState,intent:WorldIntent,decisionId:string,now:number){
  if(state.decisions.includes(decisionId))return [];
  for(const a of intent.actions){if(a.sourceCardIds.some(id=>!state.weights[id]))throw new WorldError('unknown_card_source',400);
    if((a.type==='effect'||a.type==='duplicate')&&!state.elements.some(e=>e.id===a.targetId&&e.status==='displayed'))throw new WorldError('unknown_world_target',400);}
  const created:WorldElement[]=[];
  for(const [i,a]of intent.actions.entries()){
    const target=state.elements.find(e=>e.id===a.targetId);
    if((a.type==='effect'||a.type==='duplicate')&&target){target.effects=[...new Set([...target.effects,...a.effects])];target.count=a.type==='duplicate'?Math.min(1000,target.count+a.count):a.effects.includes('multiply')?Math.min(1000,target.count*Math.max(2,a.count)):target.count;target.sourceCardIds=[...new Set([...target.sourceCardIds,...a.sourceCardIds])];target.reinforcedAt=now;continue;}
    const count=a.effects.includes('multiply')?Math.max(2,a.count):a.count;
    const same=state.elements.find(e=>e.concept===a.concept&&e.kind===a.type&&e.status==='displayed'&&[...e.effects].sort().join() === [...a.effects].sort().join());
    if(same){same.count=Math.min(1000,same.count+count);same.effects=[...new Set([...same.effects,...a.effects])];same.reinforcedAt=now;same.sourceCardIds=[...new Set([...same.sourceCardIds,...a.sourceCardIds])];continue;}
    const reusable=state.elements.find(e=>e.concept===a.concept&&e.kind===a.type&&e.status==='displayed');
    const element:WorldElement={id:`${decisionId.slice(0,70)}-${i}`,concept:a.concept,kind:a.type==='background'?'background':'prop',sourceCardIds:a.sourceCardIds,effects:a.effects,count,reinforcedAt:now,status:reusable?'ready':'preparing',...(reusable?.assetUrl?{assetUrl:reusable.assetUrl}:{})};
    state.elements.push(element);created.push(element);
  }
  state.decisions=[...state.decisions,decisionId].slice(-256);state.revision++;
  // Keep bounded rich state; old concepts still survive in weights and daily history.
  if(state.elements.length>128)state.elements=state.elements.sort((a,b)=>b.reinforcedAt-a.reinforcedAt).slice(0,128);
  return created;
}
export function assertHost(state:SharedWorldState,visitor:string,clientId:string,token:string,epoch:number,now:number){
  if(!state.host||state.host.visitor!==visitor||state.host.clientId!==clientId||state.host.token!==token||state.host.until<=now||state.epoch!==epoch||state.resetUntil>now)throw new WorldError('host_lease_lost',403);
}
export function sharedWorldContext(state:SharedWorldState,now:number){const context={
  cards:Object.entries(state.weights).map(([id,e])=>({id,weight:Math.round(cardWeight(e,now)*1000)/1000,total:e.total,unexpressed:!state.elements.some(x=>x.status!=='failed'&&x.sourceCardIds.includes(id))})),
  recentOrder:state.history.slice(-32).map(e=>({cardId:e.cardId,sequence:e.sequence})),
  elements:[...state.elements].sort((a,b)=>b.reinforcedAt-a.reinforcedAt).slice(0,16).map(e=>({id:e.id,concept:e.concept,count:e.count,effects:e.effects,status:e.status,stage:elementStage(e,now),influence:Math.round(traceWeight(e,now)*1000)/1000,sourceCardIds:e.sourceCardIds})),
  displayedWorld:{location:state.elements.some(e=>e.kind==='background'&&e.status==='displayed'&&elementStage(e,now)!=='trace')?state.displayedWorld.location:initialWorld().location},outcomes:state.outcomes.slice(-6).map(text=>text.slice(0,240)),
  instruction:'Cards seed possibilities, not immediate generation. Interpret minority cards and order too. Choose your own moment, or actions []. Use worldIntent (up to four actions) for props, effects, duplicates, backgrounds. Use generic English concepts. Source IDs must be present. Dancing is sprite dance, never video. Do not claim preparing/ready/failed objects are visible. Refer only to displayed objects as seen. Never claim to hold them. Acknowledge an attempt rather than promise success.',
};
  // Preserve every card and recent input order within the existing prompt contract.
  while(JSON.stringify(context).length>11500&&context.elements.length)context.elements.pop();
  return JSON.stringify(context);
}
