import { useEffect, useRef } from 'react';
import { WorldPhysics, type SpriteBody } from './physics';
import type { WorldEffect } from './cards';
import type { WorldRect } from '../world/worldLayout';

export function PhysicsLayer({root,epoch,mode,effects,protectedRects}:{root:React.RefObject<HTMLDivElement|null>;epoch:number;mode:'normal'|'water'|'zero';effects:WorldEffect[];protectedRects:WorldRect[]}){
  const config=useRef({mode,effects,protectedRects});
  useEffect(()=>{config.current={mode,effects,protectedRects};},[mode,effects,protectedRects]);
  useEffect(()=>{
    const element=root.current;if(!element)return;
    const engine=new WorldPhysics();const reduced=matchMedia('(prefers-reduced-motion: reduce)');
    let frame=0;let last=0;let scanAt=0;let nodes:HTMLElement[]=[];let pointer={x:-1000,y:-1000,until:0};
    const point=(event:PointerEvent)=>{pointer={x:event.clientX,y:event.clientY,until:performance.now()+900};};
    const focus=(event:FocusEvent)=>{if(event.target instanceof HTMLElement){const r=event.target.getBoundingClientRect();pointer={x:r.x+r.width/2,y:r.y+r.height/2,until:performance.now()+3000};}};
    document.addEventListener('pointermove',point);document.addEventListener('pointerdown',point);document.addEventListener('focusin',focus);
    const tick=(time:number)=>{
      const bounds=element.getBoundingClientRect();engine.resize(bounds.width,bounds.height);
      engine.protect(config.current.protectedRects.map(r=>({x:r.x*bounds.width,y:r.y*bounds.height,width:r.width*bounds.width,height:r.height*bounds.height})));
      if(time-scanAt>200){scanAt=time;nodes=[...element.querySelectorAll<HTMLElement>('[data-physics-id]')];
        const specs:SpriteBody[]=nodes.map(node=>({id:node.dataset.physicsId!,x:Number(node.dataset.x)*bounds.width,y:Number(node.dataset.y)*bounds.height,size:Number(node.dataset.size)*Math.min(bounds.width,bounds.height),effects:JSON.parse(node.dataset.effects??'[]')}));engine.sync(specs);}
      if(!reduced.matches&&!document.hidden){engine.step(last?time-last:0,config.current.mode,config.current.effects);
        for(const node of nodes){const entry=engine.bodies.get(node.dataset.physicsId!);if(!entry)continue;const {body,spec}=entry;
          node.style.left='0';node.style.top='0';node.style.width=`${spec.size}px`;node.style.height=`${spec.size}px`;
          node.style.transform=`translate(${body.position.x-spec.size/2}px,${body.position.y-spec.size/2}px) rotate(${body.angle}rad)`;
          node.style.opacity=pointer.until>time&&Math.hypot(body.position.x+bounds.x-pointer.x,body.position.y+bounds.y-pointer.y)<150?'.08':'1';
        }
      }else{for(const node of nodes){node.style.transform='';node.style.left=`${Number(node.dataset.x)*100}%`;node.style.top=`${Number(node.dataset.y)*100}%`;}}
      last=time;frame=requestAnimationFrame(tick);
    };frame=requestAnimationFrame(tick);
    return()=>{cancelAnimationFrame(frame);engine.dispose();document.removeEventListener('pointermove',point);document.removeEventListener('pointerdown',point);document.removeEventListener('focusin',focus);};
  },[root,epoch]);
  return null;
}
