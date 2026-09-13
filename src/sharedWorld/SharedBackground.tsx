import { useState } from 'react';
import type { WorldElement } from './state';

/** Keep the last usable image until the desired image decodes on this screen. */
export function SharedBackground({elements,desiredId,onDisplayed,onFailed}:{elements:WorldElement[];desiredId?:string;onDisplayed:(element:WorldElement)=>void;onFailed:(id:string)=>void}){
  const [loaded,setLoaded]=useState<ReadonlySet<string>>(()=>new Set());
  const [failed,setFailed]=useState<ReadonlySet<string>>(()=>new Set());
  const backgrounds=elements.filter(e=>e.kind==='background'&&e.assetUrl&&!failed.has(e.id));
  const desired=backgrounds.find(e=>e.id===desiredId);
  const previous=backgrounds.find(e=>e.status==='displayed'&&e.id!==desiredId);
  const images=[previous,desired??backgrounds.find(e=>e.status==='displayed')].filter((e,index,list):e is WorldElement=>!!e&&list.findIndex(x=>x?.id===e.id)===index);
  return <div className="shared-background-layer" aria-hidden>{images.map(e=><img key={e.id} className="shared-world-background" src={e.assetUrl} alt="" style={{visibility:loaded.has(e.id)?'visible':'hidden'}} onLoad={()=>{setLoaded(old=>new Set([...old,e.id]));onDisplayed(e);}} onError={()=>{setFailed(old=>new Set([...old,e.id]));onFailed(e.id);}}/>)}</div>;
}
