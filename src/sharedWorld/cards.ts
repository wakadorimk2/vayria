import type { WildcardCardData } from '../cards/cardTypes.js';

export const WORLD_CATEGORIES = ['モノ', '性質', '動き', '環境', '雰囲気'] as const;
export type WorldCategory = typeof WORLD_CATEGORIES[number];
export const WORLD_EFFECTS = ['dance', 'rotate', 'fall', 'float', 'multiply', 'grow', 'shrink', 'sparkle', 'sway', 'slide', 'transparent', 'glow', 'bounce'] as const;
export type WorldEffect = typeof WORLD_EFFECTS[number];
export interface WorldCardMeaning { category: WorldCategory; subject: string; icon: string; effects: WorldEffect[]; examples: string[] }
const additions: [string, string, WorldCategory, string, string, WorldEffect[]][] = [
  ['crab','カニ','モノ','crab','🦀',[]], ['mandarin','みかん','モノ','mandarin orange','🍊',[]],
  ['jellyfish','クラゲ','モノ','jellyfish','🪼',[]], ['flower','花','モノ','flower','🌸',[]],
  ['sword','剣','モノ','sword','⚔️',[]], ['umbrella','傘','モノ','umbrella','☂️',[]],
  ['cake','ケーキ','モノ','cake','🍰',[]], ['cat','猫','モノ','cat','🐈',[]],
  ['fish','魚','モノ','fish','🐟',[]], ['mushroom','きのこ','モノ','mushroom','🍄',[]],
  ['balloon','風船','モノ','balloon','🎈',[]], ['robot','ロボット','モノ','robot','🤖',[]],
  ['transparent','透明','性質','transparent','🫥',['transparent']], ['glowing','発光','性質','glowing','💡',['glow']],
  ['fluffy','ふわふわ','性質','fluffy','☁️',['sway']], ['golden','金色','性質','golden','🟡',[]],
  ['ice','氷','性質','icy','🧊',[]], ['elastic','弾力','性質','elastic','🫧',['bounce']],
  ['dance','踊る','動き','dancing','💃',['dance']], ['rotate','回る','動き','rotating','🌀',['rotate']],
  ['fall','落ちる','動き','falling','⬇️',['fall']], ['float','浮く','動き','floating','🪽',['float']],
  ['multiply','増える','動き','multiplying','✨',['multiply']],
  ['zero-gravity','無重力','環境','zero gravity','🪐',['float']], ['desert','砂漠','環境','desert','🏜️',[]],
  ['space','宇宙','環境','outer space','🌌',['float']], ['snow','雪','環境','snow','❄️',['fall']],
  ['forest','森','環境','forest','🌳',[]],
  ['cute','かわいい','雰囲気','cute','🎀',[]], ['ominous','不穏','雰囲気','ominous','👁️',[]],
  ['luxurious','豪華','雰囲気','luxurious','👑',['sparkle']], ['quiet','静か','雰囲気','quiet','🤫',[]],
];
export const addedWorldCards: WildcardCardData[] = additions.map(([id,label,category,subject]) => ({
  id, label, kind: category === '雰囲気' ? 'mood' : category === 'モノ' || category === '環境' ? 'concept' : 'effect',
  prompt: `${label}（${subject}）を連想する。他のカードや目の前の世界と自由に組み合わせる。`,
  stylePrompt: `${label}の意味を自然に会話へ反映する。投入だけで出現したとは断定しない。`,
}));
const legacy: Record<string, Partial<WorldCardMeaning>> = {
  chicken: {category:'モノ',subject:'chicken',icon:'🐓'}, gigantic:{category:'性質',effects:['grow'],icon:'🔍'},
  tiny:{category:'性質',effects:['shrink'],icon:'🔎'}, rain:{category:'環境',subject:'rain',effects:['fall'],icon:'🌧️'},
  underwater:{category:'環境',subject:'underwater',effects:['float'],icon:'🌊'}, sparkle:{category:'性質',effects:['sparkle'],icon:'✨'},
  'upside-down':{category:'性質',effects:['rotate'],icon:'🙃'}, 'distant-thunder':{category:'環境',subject:'distant thunder',icon:'⛈️'},
};
const meanings = new Map(additions.map(([id,,category,subject,icon,effects]) => [id, {category,subject,icon,effects,examples:['鶏','カニ','みかん']} satisfies WorldCardMeaning]));
export function worldCardMeaning(card: WildcardCardData): WorldCardMeaning {
  return meanings.get(card.id) ?? {category:'雰囲気',subject:card.label,icon:'🃏',effects:[],examples:['会話','現在の世界'],...legacy[card.id]};
}
/** Rendering-only changes deliberately do not create new material requests. */
export function worldCardVisual(card:WildcardCardData):{target?:'background'|'prop';modifier?:string}{
  const meaning=worldCardMeaning(card);
  if(meaning.category==='モノ')return {target:'prop'};
  if(['underwater','space','desert','snow','forest','rain','distant-thunder'].includes(card.id))return {target:'background'};
  const modifiers:Record<string,string>={fluffy:'fluffy',golden:'golden',ice:'icy',cute:'cute',ominous:'ominous',luxurious:'luxurious',quiet:'serene'};
  return {modifier:modifiers[card.id]};
}
// Each card has a stable motif and colour; effects reuse its semantic definition.
export function worldMatchPresentation(card:WildcardCardData){
  const meaning=worldCardMeaning(card);
  const hue=[...card.id].reduce((n,c)=>(n*31+c.charCodeAt(0))%360,0);
  return {icon:meaning.icon,label:card.label,hue,effects:meaning.effects,flock:meaning.category==='モノ'};
}
