import type { CSSProperties, ReactNode } from 'react';
import { WildcardCard, type WildcardCardProps } from './WildcardCard';
import type { CardDropPreview } from './cardDropPreview';

/** Both local exchange and shared insertion use the same card surface and fan. */
export function CardSurface({zone,index,...props}:WildcardCardProps&{zone:'brain'|'hand';index:number}){
  return <WildcardCard {...props} handIndex={zone==='hand'?index:undefined} style={zone==='hand'?{'--hand-rotation':`${(index-2)*4}deg`,'--hand-rest-lift':`${[5,2,0,2,5][index]??0}px`} as CSSProperties:undefined}/>;
}
export function BrainCardFrame({preview,children,slotId}:{preview:CardDropPreview|null;children:ReactNode;slotId?:string}){
  return <div data-world-slot={slotId} className={`brain-card-float${preview?` brain-card-float--drop-${preview.phase}`:''}`} style={preview?{'--brain-drop-retreat-y':`${preview.retreatY}px`,'--brain-drop-rotation':`${preview.rotationDeg}deg`,'--brain-drop-scale':preview.scale} as CSSProperties:undefined}>{children}</div>;
}
