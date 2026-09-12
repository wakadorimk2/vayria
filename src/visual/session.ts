import type { PlacementDiagnostic } from './diagnostics';
import { visualFailureMessage } from './notice';
import { fallbackLayout, type WorldLayout } from '../world/worldLayout';
import { VISUAL_EFFECTS, type VisualIntent, type VisualAsset, type VisualEffect } from './types';
export interface VisualObject { id: string; deadline?:number; held?:boolean; displayedMs?:number; displaySince?:number; layoutAspect?:number; eventId?: string; asset: VisualAsset; at: number; visible: boolean; effects: VisualEffect[] }
export function visualDisplayAge(object:VisualObject,now:number){return (object.displayedMs??0)+(object.visible&&!object.held?Math.max(0,now-(object.displaySince??object.at)):0);}
export interface VisualJob { id: string; target: string; intent: VisualIntent; ticket: string; at: number; source?: VisualAsset; controller?: AbortController }
export interface VisualNotice { id:string; message:string; until:number; order:number }
export interface VisualSnapshot { ready?:VisualObject[]; notification?:VisualNotice; enabled: boolean; generation: number; now: number; objects: VisualObject[]; background: VisualObject | null; pending: VisualJob[]; history: string[]; outcomes:string[] }
export interface VisualDependencies {
  now(): number;
  generate(job: VisualJob, signal: AbortSignal, asset: (value: VisualAsset) => Promise<void>): Promise<void>;
  cancel?(ticket: string): Promise<void>;
  prepare(asset: VisualAsset, signal: AbortSignal, job?:VisualJob): Promise<void>;
  release?(asset:VisualAsset):void;
  notice?(id: string, description: string): void;
  diagnostic?(event: string, id: string, milliseconds: number, placement?:PlacementDiagnostic): void;
}
export class VisualSession {
  private snapshot: VisualSnapshot = {enabled:false,generation:0,now:0,objects:[],background:null,pending:[],history:[],outcomes:[]};
  private listeners=new Set<()=>void>(); private accepted=new Set<string>(); private notices=new Set<string>(); private active=0; private inputTimes=new Map<string,number>();
  private orders=new Map<string,number>(); private order=0; private notificationOrder=0;
  private heldNotices=new Set<string>();
  private layout:WorldLayout=fallbackLayout();
  setLayout=(layout:WorldLayout)=>{this.layout=layout;};
  getLayout=()=>this.layout;
  constructor(private deps:VisualDependencies){}
  getSnapshot=()=>this.snapshot;
  subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
  bind(notice:VisualDependencies['notice']){this.deps.notice=notice;}
  private publish(patch:Partial<VisualSnapshot>={}){this.snapshot={...this.snapshot,...patch,now:this.deps.now()};for(const listener of this.listeners)listener();}
  status(id:string,code:string,generation:number){
    if(!this.snapshot.enabled||generation!==this.snapshot.generation)return;
    const order=this.orders.get(id)??++this.order;this.orders.set(id,order);
    if(order<this.notificationOrder)return;this.notificationOrder=order;
    const pending=['deciding','queued','generating','preparing','video_preparing'].includes(code);
    const message=code==='deciding'?'出すものを確認しています。':code==='queued'?'生成の順番を待っています。':code==='generating'?'小物を準備しています。':code==='preparing'?'素材の表示を確認しています。':code==='video_preparing'?'動画を準備しています。':code==='video_playing'?'動画を再生しました。':code==='displayed'?'表示しました。':code==='cancelled'?'生成を取り消しました。':visualFailureMessage(code);
    this.publish({notification:{id,message,order,until:pending?this.deps.now()+60000:this.deps.now()+6000}});
  }
  mediaStage(id:string,stage:string){this.deps.diagnostic?.(stage,id,this.deps.now()-(this.inputTimes.get(this.snapshot.ready?.find(o=>o.eventId===id)?.id??id)??this.deps.now()));}
  modeNotice(message:string){this.notificationOrder=++this.order;this.publish({notification:{id:'mode',message,order:this.order,until:this.deps.now()+6000}});}
  hold(id:string,assetId?:string){
    const object=this.snapshot.ready?.find(o=>o.id===id)??this.snapshot.objects.find(o=>o.id===id);
    if(!object||(assetId&&object.asset.id!==assetId)||object.held)return;
    const pause=(o:VisualObject)=>o.id===id?{...o,held:true,displayedMs:visualDisplayAge(o,this.deps.now()),displaySince:undefined}:o;
    this.publish({objects:this.snapshot.objects.map(pause),ready:this.snapshot.ready?.map(pause)});
    this.deps.diagnostic?.('placement_held',object.eventId??id,visualDisplayAge(object,this.deps.now()),{targetId:id,reason:'ui_blocked',displayedMs:visualDisplayAge(object,this.deps.now())});
    if(!this.heldNotices.has(id)&&this.snapshot.enabled){this.heldNotices.add(id);this.modeNotice('UIを閉じると小物が戻ります');}
  }
  placementFailed(id:string,assetId?:string,code='placement_unavailable'){
    if(code==='placement_unavailable'){this.hold(id,assetId);return;}
    const object=this.snapshot.ready?.find(o=>o.id===id)??this.snapshot.objects.find(o=>o.id===id);if(!object||(assetId&&object.asset.id!==assetId))return;
    this.deps.release?.(object.asset);
    if(object.visible&&object.asset.kind==='video'){
      const source=object.asset.source;
      this.publish({objects:source?this.snapshot.objects.map(o=>o===object?{...object,asset:source,visible:true}:o):this.snapshot.objects.filter(o=>o!==object)});
    }
    this.publish({ready:this.snapshot.ready?.filter(o=>o!==object),outcomes:[...this.snapshot.outcomes,'小物は配置できなかった。表示済みの対象は維持した。'].slice(-8)});
    this.status(object.eventId??id,code,this.snapshot.generation);
    this.deps.diagnostic?.(code,object.eventId??id,0);
  }
  permission(enabled:boolean,generation:number){
    for(const job of this.snapshot.pending){job.controller?.abort();void this.deps.cancel?.(job.ticket).catch(()=>{});}
    for(const o of this.snapshot.ready??[])this.deps.release?.(o.asset);
    const objects=this.snapshot.objects.map(o=>{if(!enabled&&o.asset.kind==='video'&&o.asset.source){this.deps.release?.(o.asset);return {...o,asset:o.asset.source};}return o;});
    this.publish({enabled,generation,objects,pending:[],ready:[],notification:undefined,outcomes:!enabled&&this.snapshot.pending.length?[...this.snapshot.outcomes,'保留中の生成を取り消した。表示済みの対象は維持した。'].slice(-8):this.snapshot.outcomes});
  }
  reset(){this.permission(false,this.snapshot.generation);this.accepted.clear();this.notices.clear();this.heldNotices.clear();this.orders.clear();for(const o of [...this.snapshot.objects,...(this.snapshot.background?[this.snapshot.background]:[])])this.deps.release?.(o.asset);this.publish({objects:[],background:null,history:[],outcomes:[]});}
  dispatch(id:string,intent:VisualIntent,ticket:string,generation:number){
    if(!this.snapshot.enabled||generation!==this.snapshot.generation||this.accepted.has(id)||intent.type==='none')return false;
    this.accepted.add(id);this.status(id,'queued',generation);this.inputTimes.set(intent.targetId||id,this.deps.now());this.deps.diagnostic?.('intent_received',id,0);
    const target=intent.type==='background'?'background':intent.targetId||id;
    const staleReady=this.snapshot.ready?.filter(o=>o.id===target)??[];for(const o of staleReady)this.deps.release?.(o.asset);
    this.publish({ready:this.snapshot.ready?.filter(o=>o.id!==target)});
    const superseded=this.snapshot.pending.filter(j=>j.target===target);superseded.forEach(j=>j.controller?.abort());
    this.publish({pending:this.snapshot.pending.filter(j=>j.target!==target)});
    for(const old of superseded)void this.deps.cancel?.(old.ticket).catch(()=>{});
    if(intent.action==='cancel'){for(const o of this.snapshot.objects.filter(o=>o.id===target&&o.held))this.deps.release?.(o.asset);this.publish({objects:this.snapshot.objects.filter(o=>o.id!==target||!o.held)});const controller=new AbortController();void this.deps.generate({id,target,intent,ticket,at:this.deps.now(),controller},controller.signal,async()=>{}).then(()=>{if(this.snapshot.enabled&&this.snapshot.generation===generation){this.status(id,'cancelled',generation);this.publish({outcomes:[...this.snapshot.outcomes,'対象の保留要求を取り消した。表示済みの対象は消していない。'].slice(-8)});}}).catch(error=>this.status(id,error instanceof Error?error.message:'failed',generation));return true;}
    if(intent.type==='effect'){
      const effects=[intent.concept,...intent.modifiers].filter(e=>VISUAL_EFFECTS.includes(e as VisualEffect)) as VisualEffect[];
      const controller=new AbortController();
      void this.deps.generate({id,target,intent,ticket,at:this.deps.now(),controller},controller.signal,async()=>{}).then(()=>{
        if(!this.snapshot.enabled||this.snapshot.generation!==generation)return;
        let changed=false;
        const objects=this.snapshot.objects.map(o=>{if(o.id!==target||!o.visible)return o;changed=true;return{...o,effects:[...new Set([...o.effects,...effects])]};});
        this.publish({objects});this.status(id,changed?'displayed':'placement_unavailable',generation);if(changed)this.deps.notice?.(id,'表示中の小物に演出が加わった。');
      }).catch(error=>{this.status(id,error instanceof Error?error.message:'failed',generation);this.deps.diagnostic?.('effect_rejected',id,0);});return true;
    }
    const waiting=this.snapshot.pending.find(j=>!j.controller);
    if(waiting){void this.deps.cancel?.(waiting.ticket).catch(()=>{});this.status(waiting.id,'queue_replaced',generation);this.deps.diagnostic?.('queue_replaced',waiting.id,this.deps.now()-waiting.at);this.publish({pending:this.snapshot.pending.filter(j=>j!==waiting)});}
    const source=[...this.snapshot.objects,...(this.snapshot.ready??[])].find(o=>o.id===target)?.asset;
    this.publish({pending:[...this.snapshot.pending,{id,target,intent,ticket,at:this.deps.now(),source:source?structuredClone(source.source??source):undefined}]});this.pump();return true;
  }
  private current(job:VisualJob,generation:number){return this.snapshot.enabled&&this.snapshot.generation===generation&&this.snapshot.pending.includes(job)&&!job.controller?.signal.aborted;}
  private pump(){
    while(this.active<2){
      const job=this.snapshot.pending.find(j=>!j.controller);if(!job)return;
      const generation=this.snapshot.generation;job.controller=new AbortController();this.active++;this.status(job.id,'generating',generation);
      void this.deps.generate(job,job.controller.signal,async asset=>{
        if(!this.current(job,generation))return;
        this.status(job.id,'preparing',generation);
        await this.deps.prepare(asset,job.controller!.signal,job);
        if(!this.current(job,generation)){this.deps.release?.(asset);return;}
        const old=job.intent.type==='background'?this.snapshot.background:this.snapshot.objects.find(o=>o.id===job.target)??this.snapshot.ready?.find(o=>o.id===job.target);
        const object:VisualObject={id:job.target,eventId:job.id,deadline:job.at+30000,asset,held:old?.held,displayedMs:old?visualDisplayAge(old,this.deps.now()):0,layoutAspect:old?.layoutAspect??(asset.width&&asset.height?asset.width/asset.height:1),at:old?.at??this.deps.now(),visible:false,effects:[...new Set([...(old?.effects??[]),...job.intent.modifiers.filter(m=>VISUAL_EFFECTS.includes(m as VisualEffect)) as VisualEffect[]])]};
        const ready=[...(this.snapshot.ready??[]).filter(o=>o.id!==object.id),object];
        const ids=[...new Map([...this.snapshot.objects,...ready].filter(o=>o.id!=='background').map(o=>[o.id,o])).values()].reverse().sort((a,b)=>b.at-a.at).slice(0,3).map(o=>o.id);
        for(const o of [...this.snapshot.objects,...ready])if(o.id!=='background'&&!ids.includes(o.id))this.deps.release?.(o.asset);
        const evicted=new Set([...this.snapshot.objects,...ready].filter(o=>o.id!=='background'&&!ids.includes(o.id)).map(o=>o.id));
        for(const pending of this.snapshot.pending)if(evicted.has(pending.target)){pending.controller?.abort();void this.deps.cancel?.(pending.ticket).catch(()=>{});}
        this.publish({pending:this.snapshot.pending.filter(j=>!evicted.has(j.target)),objects:this.snapshot.objects.filter(o=>ids.includes(o.id)),ready:ready.filter(o=>o.id==='background'||ids.includes(o.id))});
        this.deps.diagnostic?.('asset_prepared',job.id,this.deps.now()-job.at);
      }).catch(error=>{if(this.current(job,generation)){this.status(job.id,error instanceof Error?error.message:'failed',generation);this.publish({outcomes:[...this.snapshot.outcomes,'今回の生成は失敗した。以前から表示中の対象はそのまま残っている。'].slice(-8)});this.deps.diagnostic?.(error instanceof Error&&/^[\w-]+$/.test(error.message)?error.message:'failed',job.id,this.deps.now()-job.at);}})
        .finally(()=>{this.active--;this.publish({pending:this.snapshot.pending.filter(j=>j!==job)});this.pump();});
    }
  }
  visible(id:string,assetId?:string){
    const object=this.snapshot.ready?.find(o=>o.id===id)??(id==='background'?this.snapshot.background:this.snapshot.objects.find(o=>o.id===id));
    if(!object||(object.visible&&!object.held)||(object.held&&!this.snapshot.enabled)||(assetId&&object.asset.id!==assetId))return;
    const old=this.snapshot.objects.find(o=>o.id===id);
    const updated={...object,visible:true,held:false,displayedMs:old?visualDisplayAge(old,this.deps.now()):object.displayedMs??0,displaySince:this.deps.now(),at:old?.at??object.at};
    this.deps.diagnostic?.(object.held?'placement_resumed':'placement_shown',object.eventId??id,updated.displayedMs,{targetId:id,reason:'space_available',displayedMs:updated.displayedMs});
    const ready=this.snapshot.ready?.filter(o=>o!==object);
    if(id==='background'){if(this.snapshot.background)this.deps.release?.(this.snapshot.background.asset);this.publish({background:updated,ready});}
    else {const objects=[...this.snapshot.objects.filter(o=>o.id!==id),updated].slice(-3);for(const old of this.snapshot.objects)if(!objects.includes(old))this.deps.release?.(old.asset);this.publish({objects,ready});}
    if(object.visible&&object.held)return;
    const waitingVideo=object.asset.kind==='image'&&this.snapshot.pending.some(j=>j.target===id&&j.intent.motion);
    this.status(object.eventId??id,waitingVideo?'video_preparing':object.asset.kind==='video'?'video_playing':'displayed',this.snapshot.generation);
    const noticeId=(object.eventId??id)+(object.asset.kind==='video'?':video':'');
    if(!this.notices.has(noticeId)){this.notices.add(noticeId);const description=id==='background'?`背景が${object.asset.concept}の画像になった。`:`近くに${object.asset.concept}の${object.asset.kind==='video'?'動画':'小物'}が表示された。握ってはいない。`;
      this.publish({history:[...this.snapshot.history,description].slice(-8)});this.deps.notice?.(noticeId,description);}
    this.deps.diagnostic?.(object.asset.kind==='video'?'first_video_display':'first_display',object.eventId??id,this.deps.now()-(this.inputTimes.get(id)??object.at));
  }
  tick(){
    const now=this.deps.now();const pending=this.snapshot.pending.filter(j=>{
      if(now-j.at<(j.intent.type==='background'?60000:30000))return true;j.controller?.abort();void this.deps.cancel?.(j.ticket).catch(()=>{});this.status(j.id,'timeout',this.snapshot.generation);this.deps.diagnostic?.('timeout',j.id,now-j.at);this.snapshot={...this.snapshot,outcomes:[...this.snapshot.outcomes,'生成の待機上限に達した。現在の表示は維持した。'].slice(-8)};return false;
    });
    for(const o of this.snapshot.objects)if(visualDisplayAge(o,now)>=45000)this.deps.release?.(o.asset);
    this.publish({notification:this.snapshot.notification&&this.snapshot.notification.until>now?this.snapshot.notification:undefined,pending,objects:this.snapshot.objects.filter(o=>visualDisplayAge(o,now)<45000)});this.pump();
  }
}
export function visualContext(s:VisualSnapshot){
  return ['現在表示済みの世界:',...(s.background?.visible?[`background: ${s.background.asset.concept}`]:[]),...s.objects.filter(o=>o.visible&&!o.held).map(o=>`${o.id}: ${o.asset.concept}; effects=${o.effects.join(',')}`),
    `生成許可: ${s.enabled?'ON':'OFF'}`,'未完成の予告は完成物ではない。手に持ったとは断定しない。',s.pending.length?'未完成の生成要求がある。表示済みの対象に含めない。':'生成待ちはない。','生成処理の結果（新しい対象の出現とは別）:',...s.outcomes,'過去の出来事（現在の表示とは別）:',...s.history].join('\n');
}
