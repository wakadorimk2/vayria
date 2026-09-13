import { DurableObject } from 'cloudflare:workers';
import { reserveCardGeneration, immediateCardReaction, prepareGeneration, queueConversationVisuals, cardVisualActions, visualKey } from '../src/sharedWorld/generation';
import { createHand, consumeHand, ensureCardSlots, updateCardSlot, type WorldHand } from '../src/sharedWorld/hand';
import { advanceConversation, cancelConversation, conversationView, createRoomConversation, reserveConversation, type ConversationSlot } from '../src/sharedWorld/conversation';
import { executionInput, type RoomEnv } from './worldExecution';
import { applyWorldIntent, assertHost, createSharedWorld, insertWorldCard, readWorldIntent, sharedWorldContext, validId, WorldError, type SharedWorldState } from '../src/sharedWorld/state';

export class WorldRoom extends DurableObject<RoomEnv> {
  constructor(ctx:DurableObjectState,env:RoomEnv){super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS receipts (participant TEXT, event TEXT, sequence INTEGER, PRIMARY KEY(participant,event))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rates (participant TEXT PRIMARY KEY, tokens REAL, at REAL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hands (actor TEXT PRIMARY KEY, data TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS hand_receipts (actor TEXT, event TEXT, epoch INTEGER, PRIMARY KEY(actor,event,epoch))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS presence (actor TEXT PRIMARY KEY, visitor TEXT, session TEXT, until REAL)');
  }
  private read(){const rows=this.ctx.storage.sql.exec<{state:string}>('SELECT state FROM world WHERE id=1').toArray();const state=rows[0]?JSON.parse(rows[0].state) as SharedWorldState:null;if(state&&this.env.SHARED_HAND_ENABLED==='true'&&ensureCardSlots(state))this.save(state);return state;}
  private hand(actor:string,epoch:number){
    const row=this.ctx.storage.sql.exec<{data:string}>('SELECT data FROM hands WHERE actor=?',actor).toArray()[0];
    const old=row?JSON.parse(row.data) as WorldHand:null;
    if(old?.epoch===epoch)return old;
    const hand=createHand(epoch);this.saveHand(actor,hand);return hand;
  }
  private saveHand(actor:string,hand:WorldHand){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO hands VALUES(?,?)',actor,JSON.stringify(hand));}
  private save(state:SharedWorldState){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO world VALUES(1,?)',JSON.stringify(state));}
  private snapshot(state:SharedWorldState,role:string,actor=''){return {...state,generation:undefined,hand:actor&&this.env.SHARED_HAND_ENABLED==='true'?this.hand(actor,state.epoch).cards:undefined,conversation:undefined,conversationView:conversationView(state.conversation??createRoomConversation(),actor),sharedConversation:this.env.SHARED_CONVERSATION_ENABLED==='true',host:state.host?{clientId:state.host.clientId,until:state.host.until}:null,
    history:state.history.slice(-32).map(e=>({...e,participant:undefined})),daily:undefined,decisions:undefined,
    ...(role==='guest'&&this.env.SHARED_CONVERSATION_ENABLED!=='true'?{elements:state.elements.map(e=>({...e,assetUrl:undefined})),displayedWorld:undefined}:{}),serverNow:Date.now()};}
  private broadcast(state:SharedWorldState){for(const socket of this.ctx.getWebSockets()){try{const a=socket.deserializeAttachment();socket.send(JSON.stringify(this.snapshot(state,a.role,a.actor)));}catch{socket.close(1011,'reconnect');}}}
  private participants(){
    const viewers=new Set(this.ctx.getWebSockets().map(s=>s.deserializeAttachment()?.actor));
    return this.ctx.storage.sql.exec<{actor:string;visitor:string;session:string}>('SELECT actor,visitor,session FROM presence WHERE until>? ORDER BY actor LIMIT 50',Date.now()).toArray().filter(p=>viewers.has(p.actor));
  }
  private async schedule(at=Date.now()+10000){
    const q=this.read()?.generation;
    if(q?.running)at=Math.min(at,q.running.startedAt+180000);
    else if(q?.dirty&&this.participants().length)at=Math.min(at,Math.max(q.dueAt,q.blockedUntil??0));
    await this.ctx.storage.setAlarm(Math.max(Date.now()+100,at));
  }
  private async driveGeneration(){
    let state=this.read();if(!state||!state.open||state.resetUntil>Date.now()||!this.env.WORLD_EXECUTOR||this.env.SHARED_CONVERSATION_ENABLED!=='true')return;
    const q=state.generation;if(!q)return;
    if(q.running&&Date.now()-q.running.startedAt>=180000){
      for(const e of state.elements)if(e.status==='preparing'&&e.requestedAt){e.status='failed';e.error='generation_interrupted';}
      q.running=undefined;state.revision++;this.save(state);this.broadcast(state);
    }
    if(q.running||!q.dirty||q.dueAt>Date.now()||(q.blockedUntil??0)>Date.now())return;
    const candidates=this.participants();if(!candidates.length)return;
    let person:ReturnType<WorldRoom['participants']>[number]|undefined;
    for(const candidate of candidates)if(await this.env.WORLD_EXECUTOR.visualPermission(candidate).catch(()=>false)){person=candidate;break;}
    const epochBefore=state.epoch;state=this.read();if(!state||state.epoch!==epochBefore||!state.open||state.resetUntil>Date.now())return;
    if(!person){if(state.generation){state.generation.blockedUntil=Date.now()+10000;this.save(state);}await this.schedule();return;}
    if(!this.participants().some(p=>p.actor===person.actor))return;
    const id=crypto.randomUUID();if(!prepareGeneration(state,Date.now(),id))return;
    this.save(state);this.broadcast(state);await this.schedule();
    const slot:ConversationSlot={...person,id,priority:0,at:Date.now(),expires:Date.now()+180000,kind:'autonomous',status:'running'};
    const epoch=state.epoch;
    await this.generateElements(slot,epoch);
    const latest=this.read();if(!latest||latest.epoch!==epoch||latest.generation?.running?.id!==id)return;
    latest.generation.running=undefined;
    const pending=latest.elements.filter(e=>e.status==='preparing'&&!e.requestedAt);
    if(pending.length){latest.generation.dirty=true;latest.generation.proposals=[...latest.generation.proposals,...pending.map(e=>({type:e.kind,targetId:'',concept:e.concept,sourceCardIds:e.sourceCardIds,effects:e.effects,count:e.count}))].slice(-8);}
    this.save(latest);await this.schedule();
  }
  private async drive(audio?:ArrayBuffer) {
    if(this.env.SHARED_CONVERSATION_ENABLED!=='true'||!this.env.WORLD_EXECUTOR)return;
    const state=this.read();if(!state||!state.open||state.resetUntil>Date.now())return;
    const c=state.conversation??=createRoomConversation();advanceConversation(c,Date.now());
    const viewers=new Set(this.ctx.getWebSockets().map(s=>s.deserializeAttachment()?.actor));
    const people=this.ctx.storage.sql.exec<{actor:string;visitor:string;session:string}>('SELECT actor,visitor,session FROM presence WHERE until>? ORDER BY actor LIMIT 50',Date.now()).toArray().filter(p=>viewers.has(p.actor));
    if(!c.active&&!c.reply&&!c.queue.length&&people.length&&state.sequence>(c.lastAutonomousSequence??0)&&Date.now()-c.lastAutonomousAt>=10000&&Date.now()-(state.history.find(e=>e.sequence>(c.lastAutonomousSequence??0))?.at??Date.now())>=10000){
      const person=people[0];c.lastAutonomousAt=Date.now();c.lastAutonomousSequence=state.sequence;
      reserveConversation(c,{...person,id:crypto.randomUUID(),kind:'autonomous'},Date.now());
    }
    const slot=c.active;
    if(!slot||slot.status!=='granted'||(slot.kind==='voice'&&!audio)){this.save(state);if(slot||c.reply||c.queue.length||people.length)await this.schedule();return;}
    slot.status='running';slot.expires=Date.now()+180000;state.revision++;this.save(state);this.broadcast(state);
    await this.schedule(slot.expires);
    const epoch=state.epoch;
    try{
      const result=await this.env.WORLD_EXECUTOR.conversation(executionInput(state,slot,sharedWorldContext(state,Date.now())),audio);
      const latest=this.read();if(!latest||latest.epoch!==epoch||latest.conversation?.active?.id!==slot.id)return;
      const conversation=latest.conversation;const now=Date.now();
      if(result.inputText)conversation.history.push({role:'user',content:result.inputText});
      if(result.text)conversation.history.push({role:'assistant',content:result.text});
      conversation.history=conversation.history.slice(-100);
      conversation.reply={id:slot.id,text:result.text,emotion:result.emotion,motion:result.motion,audioUrl:result.audioUrl,error:result.error,startsAt:now+750,endsAt:now+750+Math.max(3000,result.durationMs)};
      conversation.active=null;
      const intent=readWorldIntent(result.worldIntent);
      if(intent){try{applyWorldIntent(latest,queueConversationVisuals(latest,intent,now),slot.id,now);}catch{latest.outcomes=[...latest.outcomes,'演出提案を適用できなかった。'].slice(-12);}}
      latest.revision++;this.save(latest);this.broadcast(latest);
      this.ctx.waitUntil(latest.cardSlots?this.driveGeneration():this.generateElements(slot,epoch));
      await this.schedule(conversation.reply.endsAt);
    }catch(error){
      const latest=this.read();if(!latest||latest.epoch!==epoch||latest.conversation?.active?.id!==slot.id)return;
      latest.conversation.active=null;latest.outcomes=[...latest.outcomes,`会話は未完了 (${error instanceof Error&&/^[a-z_]{1,80}$/.test(error.message)?error.message:'execution_failed'})`].slice(-12);
      latest.revision++;this.save(latest);this.broadcast(latest);await this.schedule(Date.now()+1000);
    }
  }
  private async generateElements(slot:ConversationSlot,epoch:number){
    // Two independent lanes, with at most two provider jobs across the room.
    await Promise.all((['background','prop'] as const).map(async kind=>{
      for(;;){const state=this.read();if(!state||state.epoch!==epoch||!this.env.WORLD_EXECUTOR)return;
        if(state.cardSlots&&(!this.participants().length||state.generation?.running?.id!==slot.id||state.generation?.dirty&&state.sequence>state.generation.running.sequence))return;
        if(state.elements.some(e=>e.kind===kind&&e.status==='preparing'&&e.requestedAt))return;
        const element=state.elements.find(e=>e.kind===kind&&e.status==='preparing'&&!e.requestedAt);
        if(!element)return;element.requestedAt=Date.now();
        if(state.generation)state.generation.attempted=[...state.generation.attempted,visualKey(element.kind,element.concept)].slice(-512);
        this.save(state);
        const result=await this.env.WORLD_EXECUTOR.visual({roomId:state.roomId,epoch,slot,element}).catch(()=>({error:'generation_failed'}));
        const latest=this.read();if(!latest||latest.epoch!==epoch)return;
        const target=latest.elements.find(e=>e.id===element.id);if(!target||target.status!=='preparing')continue;
        const currentBackground=cardVisualActions(latest).find(a=>a.type==='background');
        if(kind==='background'&&(latest.desiredBackgroundId&&latest.desiredBackgroundId!==target.id||latest.generation?.dirty&&(!currentBackground||visualKey(kind,currentBackground.concept)!==visualKey(kind,target.concept)))){target.status='failed';target.error='superseded';}
        else if('assetUrl' in result&&result.assetUrl){target.assetUrl=result.assetUrl;target.assetSource=result.assetSource;target.status='ready';if(kind==='prop')for(const e of latest.elements)if(e.simplified&&e.sourceCardIds[0]===target.sourceCardIds[0]){e.assetUrl=result.assetUrl;target.materialOnly=true;}}
        else{target.status='failed';target.error=result.error??'generation_failed';latest.outcomes=[...latest.outcomes,`${target.concept}: 未表示 (${target.error})`].slice(-12);}
        latest.revision++;this.save(latest);this.broadcast(latest);
      }
    }));
  }
  async alarm(){const state=this.read();if(!state)return;const c=state.conversation??=createRoomConversation();
    advanceConversation(c,Date.now(),new Set(this.ctx.getWebSockets().map(s=>s.deserializeAttachment()?.actor)));
    state.revision++;this.save(state);this.broadcast(state);this.ctx.waitUntil(this.driveGeneration());await this.drive();
  }
  async fetch(request:Request){try{
    const url=new URL(request.url);const actor=request.headers.get('X-World-Actor')??'';const role=request.headers.get('X-World-Role')??'guest';
    if(url.pathname==='/events'){
      const state=this.read();if(!state)throw new WorldError('room_not_found',404);
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({role,actor});pair[1].send(JSON.stringify(this.snapshot(state,role,actor)));
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    if(url.pathname==='/voice'){
      const state=this.read();const slot=state?.conversation?.active;
      if(this.env.SHARED_CONVERSATION_ENABLED!=='true'||!slot||slot.actor!==actor||slot.id!==request.headers.get('X-World-Slot')||slot.status!=='granted'||slot.expires<=Date.now()||state?.epoch!==Number(request.headers.get('X-World-Epoch')))throw new WorldError('slot_not_granted',403);
      const audio=await request.arrayBuffer();if(audio.byteLength>640044)throw new WorldError('audio_too_large',413);
      this.ctx.waitUntil(this.drive(audio));return Response.json({shared:true});
    }
    const input=await request.json() as Record<string,unknown>;const op=String(input.op);const now=Date.now();
    let changed:SharedWorldState|null=null;
    const result=this.ctx.storage.transactionSync(()=>{
      let state=this.read();
      if(op==='create'){if(role!=='admin')throw new WorldError('forbidden',403);if(!state){state=createSharedWorld(String(input.roomId));this.save(state);}return this.snapshot(state,'host');}
      if(!state)throw new WorldError('room_not_found',404);
      if(op==='presence'){
        this.ctx.storage.sql.exec('DELETE FROM presence WHERE until<=?',now);
        if(input.session&&input.visitor)this.ctx.storage.sql.exec('INSERT OR REPLACE INTO presence VALUES(?,?,?,?)',actor,String(input.visitor),String(input.session),now+25000);
        else this.ctx.storage.sql.exec('DELETE FROM presence WHERE actor=?',actor);
        return this.snapshot(state,role,actor);
      }
      if(op==='conversation'||op==='cancel'){
        if(this.env.SHARED_CONVERSATION_ENABLED!=='true'||!state.open||state.resetUntil>now)throw new WorldError('conversation_disabled',409);
        if(input.epoch!==state.epoch)throw new WorldError('stale_world');
        const c=state.conversation??=createRoomConversation();advanceConversation(c,now);
        if(op==='cancel')cancelConversation(c,actor,String(input.id));
        else reserveConversation(c,{id:String(input.id),actor,visitor:String(input.visitor??''),session:String(input.session??''),kind:input.kind==='voice'?'voice':'text',text:typeof input.text==='string'?input.text:undefined},now);
        state.revision++;this.save(state);changed=state;return this.snapshot(state,role,actor);
      }
      for(const element of state.elements){if(element.status==='preparing'&&element.requestedAt&&now-element.requestedAt>90000){element.status='failed';element.error='generation_interrupted';state.revision++;this.save(state);}}
      if(state.resetUntil&&state.resetUntil<=now){state.resetUntil=0;state.revision++;this.save(state);}
      if(op==='state')return this.snapshot(state,role,actor);
      if(op==='join'){if(!state.open)throw new WorldError('room_closed');return this.snapshot(state,role,actor);}
      if(op==='hand-reset'){
        if(this.env.SHARED_HAND_ENABLED!=='true'||input.epoch!==state.epoch||!validId(input.eventId))throw new WorldError('stale_world');
        const exists=this.ctx.storage.sql.exec('SELECT event FROM hand_receipts WHERE actor=? AND event=? AND epoch=?',actor,input.eventId,state.epoch).toArray().length;
        if(!exists){this.saveHand(actor,createHand(state.epoch));this.ctx.storage.sql.exec('INSERT INTO hand_receipts VALUES(?,?,?)',actor,input.eventId,state.epoch);state.revision++;this.save(state);changed=state;}
        return this.snapshot(state,role,actor);
      }
      const admin=role==='admin';
      if(op==='control'){
        if(!admin)throw new WorldError('forbidden',403);
        if(input.action==='reset'){const old=state;state=createSharedWorld(old.roomId);state.epoch=old.epoch+1;state.revision=old.revision+1;state.resetUntil=now+1500;state.host=old.host;state.open=old.open;if(this.env.SHARED_HAND_ENABLED==='true')ensureCardSlots(state);this.ctx.storage.sql.exec('DELETE FROM rates');this.ctx.storage.sql.exec('DELETE FROM hands');this.ctx.storage.sql.exec('DELETE FROM hand_receipts');this.ctx.storage.sql.exec('DELETE FROM receipts');}
        else if(input.action==='open'||input.action==='close'){state.open=input.action==='open';state.revision++;}
        else throw new WorldError('invalid_control',400);
      }else if(op==='insert'){
        if(this.env.SHARED_HAND_ENABLED!=='true'||!validId(input.eventId)||input.epoch!==state.epoch||!state.open||state.resetUntil>now)throw new WorldError('stale_world');
        const receipt=this.ctx.storage.sql.exec('SELECT event FROM hand_receipts WHERE actor=? AND event=? AND epoch=?',actor,input.eventId,state.epoch).toArray()[0];
        if(receipt)return {...this.snapshot(state,role,actor),accepted:true,duplicate:true};
        const slot=state.cardSlots?.find(s=>s.id===input.slotId);
        if(!slot||slot.version!==input.slotVersion)return {...this.snapshot(state,role,actor),accepted:false,code:'slot_changed'};
        const hand=this.hand(actor,state.epoch);const card=hand.cards.find(c=>c.id===input.handCardId);if(!card)throw new WorldError('hand_card_missing');
        const rate=this.ctx.storage.sql.exec<{tokens:number;at:number}>('SELECT tokens,at FROM rates WHERE participant=?',actor).toArray()[0];
        const tokens=rate?Math.min(10,rate.tokens+Math.max(0,now-rate.at)*.003):10;if(tokens<1)throw new WorldError('card_rate_limited',429);
        insertWorldCard(state,{eventId:input.eventId,cardId:card.cardId,participant:actor,name:`参加者${actor.slice(0,4)}`},now);
        updateCardSlot(state,slot,card.cardId,input.eventId,now);immediateCardReaction(state,card.cardId,now);reserveCardGeneration(state,now);consumeHand(hand,card.id);this.saveHand(actor,hand);
        this.ctx.storage.sql.exec('INSERT INTO hand_receipts VALUES(?,?,?)',actor,input.eventId,state.epoch);
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO rates VALUES(?,?,?)',actor,tokens-1,now);
      }else if(op==='card'){
        if(this.env.SHARED_HAND_ENABLED==='true')throw new WorldError('use_hand_card',409);
        if(!validId(input.eventId)||!validId(input.cardId)||!Number.isInteger(input.epoch)||input.epoch!==state.epoch)throw new WorldError('stale_world');
        const receipt=this.ctx.storage.sql.exec<{sequence:number}>('SELECT sequence FROM receipts WHERE participant=? AND event=?',actor,input.eventId).toArray()[0];
        if(receipt)return {accepted:true,duplicate:true,sequence:receipt.sequence};
        const rate=this.ctx.storage.sql.exec<{tokens:number;at:number}>('SELECT tokens,at FROM rates WHERE participant=?',actor).toArray()[0];
        const tokens=rate?Math.min(10,rate.tokens+Math.max(0,now-rate.at)*.003):10;if(tokens<1)throw new WorldError('card_rate_limited',429);
        const event=insertWorldCard(state,{eventId:input.eventId,cardId:input.cardId,participant:actor,name:`参加者${actor.slice(0,4)}`},now);
        this.ctx.storage.sql.exec('INSERT INTO receipts VALUES(?,?,?)',actor,input.eventId,event.sequence);
        this.ctx.storage.sql.exec('INSERT OR REPLACE INTO rates VALUES(?,?,?)',actor,tokens-1,now);
        // Sequence-based receipts remain after detailed history has been compacted.
      }else if(op==='lease'){
        if(role!=='host'&&!admin)throw new WorldError('forbidden',403);
        if(!validId(input.clientId))throw new WorldError('invalid_client',400);
        const existing=state.host;
        if(existing&&existing.until>now&&(existing.clientId!==input.clientId||existing.visitor!==actor)&&input.takeover!==true)throw new WorldError('host_already_active');
        const token=existing&&existing.clientId===input.clientId&&existing.visitor===actor&&existing.until>now?existing.token:crypto.randomUUID();
        state.host={visitor:actor,clientId:input.clientId,token,until:now+30000};state.revision++;this.save(state);changed=state;return {token,epoch:state.epoch,until:state.host.until,serverNow:now};
      }else if(op==='display'&&this.env.SHARED_CONVERSATION_ENABLED==='true'){
        if(input.epoch!==state.epoch)throw new WorldError('stale_world');
        const e=state.elements.find(e=>e.id===input.elementId);if(!e||!['ready','displayed'].includes(e.status))throw new WorldError('element_not_ready');
        if(input.status==='load_failed'){const message=`${e.concept}: 一つの画面で画像を読み込めなかった。`;if(!state.outcomes.includes(message)){state.outcomes=[...state.outcomes,message].slice(-12);state.revision++;this.save(state);changed=state;}return this.snapshot(state,role,actor);}
        if(e.kind==='background'&&state.desiredBackgroundId&&state.desiredBackgroundId!==e.id)throw new WorldError('superseded');
        if(e.status==='ready'){e.status='displayed';state.outcomes=[...state.outcomes,`${e.concept}が表示された。`].slice(-12);if(e.kind==='background')state.displayedWorld.location=e.concept;else state.displayedWorld.props=[...state.displayedWorld.props.filter(p=>p.id!==e.id),{id:e.id,label:e.concept,count:e.count,scale:1,placement:'foreground' as const,asset:e.assetUrl?'generated' as const:'none' as const}].slice(-12);state.displayedWorld.revision++;state.revision++;}
      }else{
        if(role!=='host'&&!admin)throw new WorldError('forbidden',403);
        assertHost(state,actor,String(input.clientId),String(input.lease),Number(input.epoch),now);
        if(op==='guard')return {context:sharedWorldContext(state,now)};
        if(op==='decision'){
          if(!validId(input.decisionId))throw new WorldError('invalid_decision',400);
          if(input.autonomous===true&&now-state.lastDecisionAt<10000)throw new WorldError('world_decision_cooldown',429);
          state.lastDecisionAt=now;state.revision++;
        }else if(op==='intent'){
          const intent=readWorldIntent(input.intent);if(!intent||!validId(input.decisionId))throw new WorldError('invalid_world_intent',400);
          applyWorldIntent(state,intent,input.decisionId,now);
        }else if(op==='claim'){
          const element=state.elements.find(e=>e.id===input.elementId);
          if(!element||element.status!=='preparing')throw new WorldError('element_not_found',404);
          if(element.requestedAt)throw new WorldError('generation_already_requested');element.requestedAt=now;state.revision++;
        }else if(op==='element'){
          const element=state.elements.find(e=>e.id===input.elementId);if(!element)throw new WorldError('element_not_found',404);
          if(input.status==='ready'&&element.status==='preparing'&&typeof input.assetUrl==='string'){element.assetUrl=input.assetUrl;element.status='ready';}
          else if(input.status==='failed'&&element.status==='preparing'){element.status='failed';element.error=String(input.code).slice(0,80);state.outcomes=[...state.outcomes,`${element.concept}: 未表示 (${element.error})`].slice(-12);}
          else if(input.status==='displayed'&&(element.status==='ready'||element.status==='displayed')){
            if(element.status==='ready'){element.status='displayed';state.outcomes=[...state.outcomes,`${element.concept}が表示された。`].slice(-12);}
            if(element.kind==='background')state.displayedWorld.location=element.concept;
            else state.displayedWorld.props=[...state.displayedWorld.props.filter(e=>e.id!==element.id),{id:element.id,label:element.concept,count:element.count,scale:1,placement:'foreground' as const,asset:element.assetUrl?'generated' as const:'none' as const}].slice(-12);
            state.displayedWorld.revision++;
          }else if(input.status!=='displayed')throw new WorldError('invalid_element_transition');
          state.revision++;
        }else throw new WorldError('invalid_operation',400);
      }
      this.save(state);changed=state;return this.snapshot(state,role,actor);
    });
    if(changed)this.broadcast(changed);
    if(op==='conversation'||op==='cancel'||op==='presence'){this.ctx.waitUntil(this.drive());if(op==='presence')this.ctx.waitUntil(this.driveGeneration());}
    if(changed&&(op==='card'||op==='insert')&&this.env.SHARED_CONVERSATION_ENABLED==='true')await this.schedule();
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({code:error instanceof WorldError?error.code:'world_unavailable'},{status:error instanceof WorldError?error.status:503});}}
  webSocketMessage(ws:WebSocket){ws.send(JSON.stringify({type:'pong',serverNow:Date.now()}));}
  webSocketClose(ws:WebSocket,code:number){ws.close(code);}
  webSocketError(ws:WebSocket){ws.close(1011,'reconnect');}
}
