import { DurableObject } from 'cloudflare:workers';
import { applyWorldIntent, assertHost, createSharedWorld, insertWorldCard, readWorldIntent, sharedWorldContext, validId, WorldError, type SharedWorldState } from '../src/sharedWorld/state';

export class WorldRoom extends DurableObject {
  constructor(ctx:DurableObjectState,env:object){super(ctx,env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS world (id INTEGER PRIMARY KEY, state TEXT NOT NULL)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS receipts (participant TEXT, event TEXT, sequence INTEGER, PRIMARY KEY(participant,event))');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS rates (participant TEXT PRIMARY KEY, tokens REAL, at REAL)');
  }
  private read(){const rows=this.ctx.storage.sql.exec<{state:string}>('SELECT state FROM world WHERE id=1').toArray();return rows[0]?JSON.parse(rows[0].state) as SharedWorldState:null;}
  private save(state:SharedWorldState){this.ctx.storage.sql.exec('INSERT OR REPLACE INTO world VALUES(1,?)',JSON.stringify(state));}
  private snapshot(state:SharedWorldState,role:string){return {...state,host:state.host?{clientId:state.host.clientId,until:state.host.until}:null,
    history:state.history.slice(-32).map(e=>({...e,participant:undefined})),daily:undefined,decisions:undefined,
    ...(role==='guest'?{elements:state.elements.map(e=>({...e,assetUrl:undefined})),displayedWorld:undefined}:{}),serverNow:Date.now()};}
  private broadcast(state:SharedWorldState){for(const socket of this.ctx.getWebSockets()){try{const a=socket.deserializeAttachment();socket.send(JSON.stringify(this.snapshot(state,a.role)));}catch{socket.close(1011,'reconnect');}}}
  async fetch(request:Request){try{
    const url=new URL(request.url);const actor=request.headers.get('X-World-Actor')??'';const role=request.headers.get('X-World-Role')??'guest';
    if(url.pathname==='/events'){
      const state=this.read();if(!state)throw new WorldError('room_not_found',404);
      const pair=new WebSocketPair();this.ctx.acceptWebSocket(pair[1]);pair[1].serializeAttachment({role,actor});pair[1].send(JSON.stringify(this.snapshot(state,role)));
      return new Response(null,{status:101,webSocket:pair[0]});
    }
    const input=await request.json() as Record<string,unknown>;const op=String(input.op);const now=Date.now();
    let changed:SharedWorldState|null=null;
    const result=this.ctx.storage.transactionSync(()=>{
      let state=this.read();
      if(op==='create'){if(role!=='admin')throw new WorldError('forbidden',403);if(!state){state=createSharedWorld(String(input.roomId));this.save(state);}return this.snapshot(state,'host');}
      if(!state)throw new WorldError('room_not_found',404);
      for(const element of state.elements){if(element.status==='preparing'&&element.requestedAt&&now-element.requestedAt>90000){element.status='failed';element.error='generation_interrupted';state.revision++;this.save(state);}}
      if(state.resetUntil&&state.resetUntil<=now){state.resetUntil=0;state.revision++;this.save(state);}
      if(op==='state')return this.snapshot(state,role);
      if(op==='join'){if(!state.open)throw new WorldError('room_closed');return this.snapshot(state,role);}
      const admin=role==='admin';
      if(op==='control'){
        if(!admin)throw new WorldError('forbidden',403);
        if(input.action==='reset'){const old=state;state=createSharedWorld(old.roomId);state.epoch=old.epoch+1;state.revision=old.revision+1;state.resetUntil=now+1500;state.host=old.host;state.open=old.open;this.ctx.storage.sql.exec('DELETE FROM rates');}
        else if(input.action==='open'||input.action==='close'){state.open=input.action==='open';state.revision++;}
        else throw new WorldError('invalid_control',400);
      }else if(op==='card'){
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
      this.save(state);changed=state;return this.snapshot(state,role);
    });
    if(changed)this.broadcast(changed);
    return Response.json(result,{headers:{'Cache-Control':'no-store'}});
  }catch(error){return Response.json({code:error instanceof WorldError?error.code:'world_unavailable'},{status:error instanceof WorldError?error.status:503});}}
  webSocketMessage(ws:WebSocket){ws.send(JSON.stringify({type:'pong',serverNow:Date.now()}));}
  webSocketClose(ws:WebSocket,code:number){ws.close(code);}
  webSocketError(ws:WebSocket){ws.close(1011,'reconnect');}
}
