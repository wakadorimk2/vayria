import {placeWorldProp,type WorldLayout,type WorldRect} from '../world/worldLayout';
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
  return attempt(sides,[1,.8,.6,.45]);
}
