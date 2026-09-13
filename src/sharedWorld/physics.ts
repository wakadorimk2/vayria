import Matter from 'matter-js';
import type { WorldEffect } from './cards';
export interface SpriteBody {id:string;x:number;y:number;size:number;effects:WorldEffect[]}
export class WorldPhysics {
  readonly engine=Matter.Engine.create({enableSleeping:true});
  readonly bodies=new Map<string,{body:Matter.Body;spec:SpriteBody}>();
  private walls:Matter.Body[]=[];
  private width=1;private height=1;private elapsed=0;
  private obstacles:Matter.Body[]=[];private obstacleKey='';
  private transitions=new Map<string,{key:string;at:number;from:number[];to:number[];value:number[]}>();
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
    for(const [id,{body}] of this.bodies)if(!ids.has(id)){Matter.Composite.remove(this.engine.world,body);this.bodies.delete(id);this.transitions.delete(id);}
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
      for(const [id,{body,spec}] of this.bodies){
        const active=[...effects,...spec.effects];const floating=mode!=='normal'||active.includes('float');
        body.restitution=active.includes('bounce')?.8:.25;
        const to=[this.engine.gravity.y,floating?1:0,mode==='water'?.08:.015];const key=to.join();
        let transition=this.transitions.get(id);
        if(!transition){transition={key,at:t,from:to,to,value:to};this.transitions.set(id,transition);}
        else if(transition.key!==key){transition={key,at:t,from:transition.value,to,value:transition.value};this.transitions.set(id,transition);Matter.Sleeping.set(body,false);}
        const blend=Math.min(1,t-transition.at);transition.value=to.map((v,i)=>transition!.from[i]+(v-transition!.from[i])*blend);
        const [gravity,floatStrength,friction]=transition.value;body.frictionAir=friction;
        if(floatStrength>0||active.includes('dance')||active.includes('rotate'))Matter.Sleeping.set(body,false);
        const target=this.height*(.3+((body.id*17)%40)/100);
        Matter.Body.applyForce(body,body.position,{x:Math.sin(t+body.id)*body.mass*.00003*floatStrength,y:(gravity-this.engine.gravity.y)*.001*body.mass+((target-body.position.y)*body.mass*.000002-gravity*.001*body.mass)*floatStrength});
        if(active.includes('dance')){Matter.Body.applyForce(body,body.position,{x:Math.sin(t*5+body.id)*body.mass*.0003,y:Math.sin(t*7+body.id)>.9?-body.mass*.002:0});body.torque=Math.sin(t*5)*body.mass*.002;}
        if(active.includes('rotate'))Matter.Body.setAngularVelocity(body,.025);
        if(active.includes('sway')||active.includes('slide')){Matter.Sleeping.set(body,false);Matter.Body.applyForce(body,body.position,{x:Math.sin(t*2+body.id)*body.mass*.00015,y:0});if(active.includes('sway'))body.torque=Math.sin(t*2+body.id)*body.mass*.001;}
        if(active.includes('fall')&&!floating){Matter.Body.applyForce(body,body.position,{x:0,y:body.mass*.0002});}
      }
      Matter.Engine.update(this.engine,1000/60);this.elapsed-=1000/60;
    }
  }
  dispose(){Matter.Composite.clear(this.engine.world,false);Matter.Engine.clear(this.engine);this.bodies.clear();}
}
