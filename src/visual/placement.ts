import {overlaps,placeWorldProp,type WorldLayout,type WorldRect} from '../world/worldLayout';
/** Chest-first placement uses the projected body, not the viewport center. */
export function placeVisualProp(layout:WorldLayout,latest:boolean,scale:number,aspect:number,occupied:WorldRect[]=[]){
  const base=Math.min(.55,layout.width>layout.height?layout.body.width*.95:.55);
  const width=base*(latest?1:.5);const center=layout.body.x+layout.body.width/2;
  const sides=[{x:.84,y:.55},{x:.16,y:.55},{x:.84,y:.32},{x:.16,y:.32},{x:.84,y:.73},{x:.16,y:.73}];
  const attempt=(anchors:{x:number;y:number}[],shrinks:number[])=>{
    for(const shrink of shrinks){const size=Math.min(base,width*scale)*shrink;const height=size*layout.width/layout.height/aspect;
      for(const anchor of anchors){const p=placeWorldProp(layout,{...anchor,y:latest&&anchors!==sides?Math.max(anchor.y,layout.face.y+layout.face.height+height/2+.012):anchor.y},{bounds:{x:0,y:0,width:1,height:1},pivot:{x:.5,y:.5},aspect,displayWidth:size,maxWidth:base,shrinkSteps:[1]},1,occupied);if(p)return p.rect;}}
    return null;
  };
  if(latest){const chest=[{x:center,y:layout.body.y+layout.body.height*.52},{x:center,y:layout.body.y+layout.body.height*.70}];const p=attempt(chest,[1,.9,.8,.7,.6]);if(p)return p;}
  const side=attempt(sides,[1,.8,.6,.45]);if(side)return side;
  // Edges of protected rectangles define the remaining free rectangles.
  for(const shrink of [1,.9,.8,.7,.6,.45,.3,.2]){
    const size=Math.min(base,width*scale)*shrink,height=size*layout.width/layout.height/aspect;
    const blockers=[layout.face,...layout.obstacles,...occupied];
    const xs=[center,.01+size/2,.99-size/2,...blockers.flatMap(r=>[r.x-size/2-.002,r.x+r.width+size/2+.002])];
    const ys=[layout.body.y+layout.body.height*.6,.01+height/2,.99-height/2,...blockers.flatMap(r=>[r.y-height/2-.002,r.y+r.height+height/2+.002])];
    for(const y of ys)for(const x of xs){const rect={x:x-size/2,y:y-height/2,width:size,height};if(fitsVisualRect(layout,rect,occupied))return rect;}
  }
  return null;
}

export function fitsVisualRect(layout:WorldLayout,rect:WorldRect,occupied:WorldRect[]=[]){
 return rect.x>=.01&&rect.y>=.01&&rect.x+rect.width<=.99&&rect.y+rect.height<=.99&&![layout.face,...layout.obstacles,...occupied].some(r=>overlaps(rect,r));
}
export function visualMotionBounds(rect:WorldRect,layout:WorldLayout,effects:readonly string[]){
 const width=rect.width*layout.width,height=rect.height*layout.height;
 const diameter=effects.includes('rotate')?Math.hypot(width,height):0;
 const w=(Math.max(width,diameter)+(effects.some(e=>e==='slide'||e==='sway')?16:0))/layout.width,h=(Math.max(height,diameter)+(effects.some(e=>e==='float'||e==='bob')?8:0))/layout.height;
 return {x:rect.x+(rect.width-w)/2,y:rect.y+(rect.height-h)/2,width:w,height:h};
}
/** Keep valid placements; promote to chest only after the preferred rect settles. */
export class VisualPlacements {
 private positions=new Map<string,{rect:WorldRect;key:string;candidate:string;since:number}>();
 retain(ids:string[]){for(const id of this.positions.keys())if(!ids.includes(id))this.positions.delete(id);}
 choose(id:string,layout:WorldLayout,latest:boolean,scale:number,aspect:number,occupied:WorldRect[],now:number){
  const next=placeVisualProp(layout,latest,scale,aspect,occupied);
  const key=[layout.width,layout.height,latest,scale,aspect].join(':');
  const old=this.positions.get(id);
  if(old&&old.key===key&&fitsVisualRect(layout,old.rect,occupied)){
   const candidate=JSON.stringify(next&&Object.fromEntries(Object.entries(next).map(([k,v])=>[k,Math.round(v*1000)])));
   if(candidate!==old.candidate){old.candidate=candidate;old.since=now;}
   if(!next||now-old.since<300)return old.rect;
  }
  if(next)this.positions.set(id,{rect:next,key,candidate:JSON.stringify(Object.fromEntries(Object.entries(next).map(([k,v])=>[k,Math.round(v*1000)]))),since:now});
  return next;
 }
}
