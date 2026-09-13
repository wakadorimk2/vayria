import { cardPool } from '../cards/cardPool.js';
import { worldCardMeaning, worldCardVisual } from './cards.js';
import type { SharedWorldState, WorldElement, WorldIntent } from './state.js';

export const CARD_GENERATION_DELAY = 4000;
type Action = WorldIntent['actions'][number];
export interface WorldGeneration {
  dueAt:number; sequence:number; dirty:boolean;
  blockedUntil?:number;
  proposals:Action[];
  running?:{id:string;sequence:number;startedAt:number};
  attempted:string[];
}
export function visualKey(kind:string,concept:string){return `${kind}:${concept.trim().toLowerCase().replace(/\s+/g,' ')}`;}
export function cardVisualActions(state:SharedWorldState):Action[]{
  const cards=(state.cardSlots??[]).map(s=>({slot:s,card:cardPool.find(c=>c.id===s.cardId)})).filter(x=>!!x.card);
  const modifiers=cards.filter(x=>worldCardVisual(x.card!).modifier).map(x=>x.card!);
  const appearance=[...new Set(modifiers.map(c=>worldCardVisual(c).modifier!))].sort();
  const sources=modifiers.map(c=>c.id);
  const action=(type:'background'|'prop',card:typeof cardPool[number]):Action=>({type,targetId:'',concept:[...appearance,worldCardMeaning(card).subject].join(' ').slice(0,160),sourceCardIds:[...new Set([card.id,...sources])],effects:[],count:1});
  const background=cards.filter(x=>worldCardVisual(x.card!).target==='background').sort((a,b)=>b.slot.sequence-a.slot.sequence)[0]?.card;
  const props=[...new Map(cards.filter(x=>worldCardVisual(x.card!).target==='prop').map(x=>[x.card!.id,x.card!])).values()];
  return [...(background?[action('background',background)]:[]),...props.map(c=>action('prop',c))];
}
export function reserveCardGeneration(state:SharedWorldState,now:number){
  const q=state.generation??={dueAt:0,sequence:0,dirty:false,proposals:[],attempted:[]};
  q.sequence=state.sequence;q.dueAt=now+CARD_GENERATION_DELAY;q.dirty=true;q.blockedUntil=undefined;
}
export function queueConversationVisuals(state:SharedWorldState,intent:WorldIntent,now:number):WorldIntent{
  if(!state.cardSlots)return intent;
  const visuals=intent.actions.filter(a=>a.type==='background'||a.type==='prop');
  if(visuals.length){
    const q=state.generation??={dueAt:now,sequence:state.sequence,dirty:false,proposals:[],attempted:[]};
    const canonical=cardVisualActions(state);
    for(const proposal of visuals){
      // Card-driven and conversation-driven appearances share one material key.
      const derived=new Set(proposal.sourceCardIds.flatMap(id=>{const card=cardPool.find(c=>c.id===id);return card?worldCardMeaning(card).effects:[];}));
      const matches=canonical.filter(a=>proposal.sourceCardIds.includes(a.sourceCardIds[0]));
      // The card's material destination also corrects a model's misclassified scenery.
      const action=matches.find(a=>a.type===proposal.type)??matches[0]??{...proposal,effects:proposal.effects.filter(e=>!derived.has(e)||e==='multiply')};
      q.proposals=q.proposals.filter(a=>a.type==='background'&&action.type==='background'?false:visualKey(a.type,a.concept)!==visualKey(action.type,action.concept));
      q.proposals.push(action);
    }
    q.proposals=q.proposals.slice(-8);q.dirty=true;
  }
  return {actions:intent.actions.filter(a=>a.type!=='background'&&a.type!=='prop')};
}
export function prepareGeneration(state:SharedWorldState,now:number,id:string){
  const q=state.generation;if(!q||!q.dirty||q.running||q.dueAt>now)return false;
  const canonical=cardVisualActions(state);
  const current=new Set((state.cardSlots??[]).flatMap(s=>s.cardId?[s.cardId]:[]));
  const proposals=q.proposals.filter(a=>a.sourceCardIds.every(id=>current.has(id)));
  const actions=[...canonical,...proposals.filter(a=>a.type!=='background'||!canonical.some(c=>c.type==='background'))];
  q.dirty=false;q.proposals=[];q.running={id,sequence:state.sequence,startedAt:now};
  // Queued work from an older state has never reached a provider and can be discarded.
  for(const e of state.elements)if(e.status==='preparing'&&!e.requestedAt){e.status='failed';e.error='superseded';}
  const seen=new Set<string>();
  for(const [index,a] of actions.entries()){
    const key=visualKey(a.type,a.concept);
    if(seen.has(key))continue;seen.add(key);
    const material=state.elements.find(e=>!e.simplified&&visualKey(e.kind,e.concept)===key&&e.assetUrl&&['ready','displayed'].includes(e.status));
    if(material){if(a.type==='background')state.desiredBackgroundId=material.id;continue;}
    if(q.attempted.includes(key)||state.elements.some(e=>!e.simplified&&visualKey(e.kind,e.concept)===key&&e.requestedAt))continue;
    const element:WorldElement={id:`${id}-${index}`,kind:a.type==='background'?'background':'prop',concept:a.concept,sourceCardIds:a.sourceCardIds,effects:a.effects,count:a.count,status:'preparing',reinforcedAt:now};
    state.elements.push(element);if(element.kind==='background')state.desiredBackgroundId=element.id;
  }
  state.revision++;return true;
}
export function immediateCardReaction(state:SharedWorldState,cardId:string,now:number){
  const card=cardPool.find(c=>c.id===cardId)!;
  state.cardReaction={cardId,at:now,id:`reaction-${state.sequence}`};
  if(worldCardMeaning(card).category!=='モノ')return;
  const material=state.elements.find(e=>e.kind==='prop'&&!e.simplified&&e.assetUrl&&['ready','displayed'].includes(e.status)&&e.sourceCardIds.includes(cardId));
  const id=`immediate-${cardId}`;let element=state.elements.find(e=>e.id===id);
  if(!element){element={id,kind:'prop',concept:worldCardMeaning(card).subject,sourceCardIds:[cardId],effects:[],count:1,reinforcedAt:now,status:'ready',simplified:true};state.elements.push(element);}
  else{element.count=Math.min(24,element.count+1);element.reinforcedAt=now;element.status='ready';}
  if(material)element.assetUrl=material.assetUrl;
}
