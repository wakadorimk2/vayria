import Matter from 'matter-js';
import type { WorldEffect } from './cards';
export interface SpriteBody {id:string;x:number;y:number;size:number;effects:WorldEffect[]}
export class WorldPhysics {
  readonly engine=Matter.Engine.create({enableSleeping:true});
  readonly bodies=new Map<string,{body:Matter.Body;spec:SpriteBody}>();
  private walls:Matter.Body[]=[];
  private width=1;private height=1;private elapsed=0;
  private obstacles:Matter.Body[]=[];private obstacleKey='';
  protect(rects:{x:number;y:number;width:number;height:number}[]){
    const key=JSON.stringify(rects);if(key===this.obstacleKey)return;this.obstacleKey=key;
    Matter.Composite.remove(this.engine.world,this.obstacles);
    this.obstacles=rects.map(r=>Matter.Bodies.rectangle(r.x+r.width/2,r.y+r.height/2,r.width,r.height,{isStatic:true}));
    Matter.Composite.add(this.engine.world,this.obstacles);
  }
  resize(width:number,height:number){
    if(width===this.width&&height===this.height)return;
    this.width=width;this.height=height;
    Matter.Composite.remove(this.engine.world,this.walls);
    this.walls=[Matter.Bodies.rectangle(width/2,height+30,width+120,60,{isStatic:true}),Matter.Bodies.rectangle(-30,height/2,60,height*3,{isStatic:true}),Matter.Bodies.rectangle(width+30,height/2,60,height*3,{isStatic:true}),Matter.Bodies.rectangle(width/2,-100,width+120,60,{isStatic:true})];
    Matter.Composite.add(this.engine.world,this.walls);
    for(const {body} of this.bodies.values())Matter.Body.setPosition(body,{x:Math.max(30,Math.min(width-30,body.position.x)),y:Math.min(height-30,body.position.y)});
  }
  sync(specs:SpriteBody[]){
    const ids=new Set(specs.map(s=>s.id));
    for(const [id,{body}] of this.bodies)if(!ids.has(id)){Matter.Composite.remove(this.engine.world,body);this.bodies.delete(id);}
    for(const spec of specs){const old=this.bodies.get(spec.id);
      if(old){if(old.spec.size!==spec.size)Matter.Body.scale(old.body,spec.size/old.spec.size,spec.size/old.spec.size);old.spec=spec;continue;}
      const body=Matter.Bodies.circle(spec.x,spec.y,spec.size*.42,{restitution:spec.effects.includes('bounce')?.8:.25,friction:.4,frictionAir:.015});
      this.bodies.set(spec.id,{body,spec});Matter.Composite.add(this.engine.world,body);
    }
  }
  step(delta:number,mode:'normal'|'water'|'zero',effects:WorldEffect[]=[]){
    this.elapsed+=Math.min(delta,100);this.engine.gravity.y=mode==='zero'?0:mode==='water'?.12:1;
    let steps=0;
    while(this.elapsed>=1000/60&&steps++<6){
      const t=this.engine.timing.timestamp/1000;
      for(const {body,spec} of this.bodies.values()){
        const active=[...effects,...spec.effects];const floating=mode!=='normal'||active.includes('float');
        body.frictionAir=mode==='water'?.08:.015;
        if(floating||active.includes('dance')||active.includes('rotate'))Matter.Sleeping.set(body,false);
        if(floating){const target=this.height*(.3+((body.id*17)%40)/100);Matter.Body.applyForce(body,body.position,{x:Math.sin(t+body.id)*body.mass*.00003,y:(target-body.position.y)*body.mass*.000002-this.engine.gravity.y*.001*body.mass});}
        if(active.includes('dance')){Matter.Body.applyForce(body,body.position,{x:Math.sin(t*5+body.id)*body.mass*.0003,y:Math.sin(t*7+body.id)>.9?-body.mass*.002:0});body.torque=Math.sin(t*5)*body.mass*.002;}
        if(active.includes('rotate'))Matter.Body.setAngularVelocity(body,.025);
      }
      Matter.Engine.update(this.engine,1000/60);this.elapsed-=1000/60;
    }
  }
  dispose(){Matter.Composite.clear(this.engine.world,false);Matter.Engine.clear(this.engine);this.bodies.clear();}
}
