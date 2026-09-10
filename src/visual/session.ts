import { fallbackLayout, type WorldLayout } from '../world/worldLayout';
import { VISUAL_EFFECTS, type VisualIntent, type VisualAsset, type VisualEffect } from './types';
export interface VisualObject { id: string; eventId?: string; asset: VisualAsset; at: number; visible: boolean; effects: VisualEffect[] }
export interface VisualJob { id: string; target: string; intent: VisualIntent; ticket: string; at: number; controller?: AbortController }
export interface VisualSnapshot { enabled: boolean; generation: number; now: number; objects: VisualObject[]; background: VisualObject | null; pending: VisualJob[]; history: string[] }
export interface VisualDependencies {
  now(): number;
  generate(job: VisualJob, signal: AbortSignal, asset: (value: VisualAsset) => Promise<void>): Promise<void>;
  cancel?(ticket: string): Promise<void>;
  prepare(asset: VisualAsset, signal: AbortSignal): Promise<void>;
  release?(asset:VisualAsset):void;
  notice?(id: string, description: string): void;
  diagnostic?(event: string, id: string, milliseconds: number): void;
}
export class VisualSession {
  private snapshot: VisualSnapshot = {enabled:false,generation:0,now:0,objects:[],background:null,pending:[],history:[]};
  private listeners=new Set<()=>void>(); private accepted=new Set<string>(); private notices=new Set<string>(); private active=0; private inputTimes=new Map<string,number>();
  private layout:WorldLayout=fallbackLayout();
  setLayout=(layout:WorldLayout)=>{this.layout=layout;};
  getLayout=()=>this.layout;
  constructor(private deps:VisualDependencies){}
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  bind(notice:VisualDependencies['notice']){this.deps.notice=notice;}
  private publish(patch:Partial<VisualSnapshot>={}){this.snapshot={...this.snapshot,...patch,now:this.deps.now()};for(const listener of this.listeners)listener();}
  permission(enabled:boolean,generation:number){
    for(const job of this.snapshot.pending)job.controller?.abort();
    this.publish({enabled,generation,pending:[]});
  }
  reset(){this.permission(false,this.snapshot.generation);this.accepted.clear();this.notices.clear();for(const o of [...this.snapshot.objects,...(this.snapshot.background?[this.snapshot.background]:[])])this.deps.release?.(o.asset);this.publish({objects:[],background:null,history:[]});}
  dispatch(id:string,intent:VisualIntent,ticket:string,generation:number){
    if(!this.snapshot.enabled||generation!==this.snapshot.generation||this.accepted.has(id)||intent.type==='none')return false;
    this.accepted.add(id);this.inputTimes.set(intent.targetId||id,this.deps.now());this.deps.diagnostic?.('intent_received',id,0);
    const target=intent.type==='background'?'background':intent.targetId||id;
    const superseded=this.snapshot.pending.filter(j=>j.target===target);superseded.forEach(j=>j.controller?.abort());
    this.publish({pending:this.snapshot.pending.filter(j=>j.target!==target)});
    for(const old of superseded)void this.deps.cancel?.(old.ticket).catch(()=>{});
    if(intent.action==='cancel'){const controller=new AbortController();void this.deps.generate({id,target,intent,ticket,at:this.deps.now(),controller},controller.signal,async()=>{}).catch(()=>{});return true;}
    if(intent.type==='effect'){
      const effects=[intent.concept,...intent.modifiers].filter(e=>VISUAL_EFFECTS.includes(e as VisualEffect)) as VisualEffect[];
      let changed=false;
      const objects=this.snapshot.objects.map(o=>{if(o.id!==target||!o.visible)return o;changed=true;return{...o,effects:[...new Set([...o.effects,...effects])]};});
      this.publish({objects});if(changed)this.deps.notice?.(id,'表示中の小物に演出が加わった。');return true;
    }
    const waiting=this.snapshot.pending.find(j=>!j.controller);
    if(waiting){this.deps.diagnostic?.('queue_replaced',waiting.id,this.deps.now()-waiting.at);this.publish({pending:this.snapshot.pending.filter(j=>j!==waiting)});}
    this.publish({pending:[...this.snapshot.pending,{id,target,intent,ticket,at:this.deps.now()}]});this.pump();return true;
  }
  private current(job:VisualJob,generation:number){return this.snapshot.enabled&&this.snapshot.generation===generation&&this.snapshot.pending.includes(job)&&!job.controller?.signal.aborted;}
  private pump(){
    while(this.active<2){
      const job=this.snapshot.pending.find(j=>!j.controller);if(!job)return;
      const generation=this.snapshot.generation;job.controller=new AbortController();this.active++;
      void this.deps.generate(job,job.controller.signal,async asset=>{
        if(!this.current(job,generation))return;
        await this.deps.prepare(asset,job.controller!.signal);
        if(!this.current(job,generation)){this.deps.release?.(asset);return;}
        const old=job.intent.type==='background'?this.snapshot.background:this.snapshot.objects.find(o=>o.id===job.target);
        const object:VisualObject={id:job.target,eventId:job.id,asset,at:old?.at??this.deps.now(),visible:false,effects:[...new Set([...(old?.effects??[]),...job.intent.modifiers.filter(m=>VISUAL_EFFECTS.includes(m as VisualEffect)) as VisualEffect[]])]};
        if(job.intent.type==='background')this.publish({background:object});
        else {const objects=[...this.snapshot.objects.filter(o=>o.id!==job.target),object].slice(-3);for(const removed of this.snapshot.objects)if(!objects.includes(removed))this.deps.release?.(removed.asset);this.publish({objects});}
        this.deps.diagnostic?.('asset_prepared',job.id,this.deps.now()-job.at);
      }).catch(error=>{if(this.current(job,generation))this.deps.diagnostic?.(error instanceof Error&&/^[\w-]+$/.test(error.message)?error.message:'failed',job.id,this.deps.now()-job.at);})
        .finally(()=>{this.active--;this.publish({pending:this.snapshot.pending.filter(j=>j!==job)});this.pump();});
    }
  }
  visible(id:string){
    const object=id==='background'?this.snapshot.background:this.snapshot.objects.find(o=>o.id===id);
    if(!object||object.visible)return;
    const updated={...object,visible:true};
    if(id==='background')this.publish({background:updated});else this.publish({objects:this.snapshot.objects.map(o=>o.id===id?updated:o)});
    const noticeId=object.eventId??id;
    if(!this.notices.has(noticeId)){this.notices.add(noticeId);const description=id==='background'?`背景が${object.asset.concept}の画像になった。`:`近くに${object.asset.concept}の小物が表示された。握ってはいない。`;
      this.publish({history:[...this.snapshot.history,description].slice(-8)});this.deps.notice?.(noticeId,description);}
    this.deps.diagnostic?.('first_display',id,this.deps.now()-(this.inputTimes.get(id)??object.at));
  }
  tick(){
    const now=this.deps.now();const pending=this.snapshot.pending.filter(j=>{
      if(now-j.at<(j.intent.type==='background'?60000:30000))return true;j.controller?.abort();void this.deps.cancel?.(j.ticket).catch(()=>{});this.deps.diagnostic?.('timeout',j.id,now-j.at);return false;
    });
    for(const o of this.snapshot.objects)if(now-o.at>=45000)this.deps.release?.(o.asset);
    this.publish({pending,objects:this.snapshot.objects.filter(o=>now-o.at<45000)});this.pump();
  }
}
export function visualContext(s:VisualSnapshot){
  return ['現在表示済みの世界:',...(s.background?.visible?[`background: ${s.background.asset.concept}`]:[]),...s.objects.filter(o=>o.visible).map(o=>`${o.id}: ${o.asset.concept}; effects=${o.effects.join(',')}`),
    `生成許可: ${s.enabled?'ON':'OFF'}`,'未完成の予告は完成物ではない。手に持ったとは断定しない。',s.pending.length?'未完成の生成要求がある。表示済みの対象に含めない。':'生成待ちはない。','過去の出来事（現在の表示とは別）:',...s.history].join('\n');
}
