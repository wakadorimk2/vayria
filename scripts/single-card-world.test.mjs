import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const load=async path=>{const b=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
const g=await load('src/sharedWorld/generation.ts'),w=await load('src/sharedWorld/state.ts'),h=await load('src/sharedWorld/hand.ts');
function put(s,id,index,at){w.insertWorldCard(s,{cardId:id,eventId:`event-${s.sequence}`,participant:'p',name:'p'},at);h.updateCardSlot(s,s.cardSlots[index],id,`slot-${s.sequence}`,at);g.immediateCardReaction(s,id,at);g.reserveCardGeneration(s,at);}
function room(){const s=w.createSharedWorld('test');h.ensureCardSlots(s);return s;}
test('one card reacts immediately; four quiet seconds coalesce background, prop and physics',()=>{
  const s=room();put(s,'underwater',0,1000);put(s,'chicken',1,3000);put(s,'gigantic',2,4000);
  assert.equal(s.elements[0].simplified,true);assert.equal(s.elements[0].status,'ready');assert.equal(s.generation.dueAt,8000);
  assert.equal(g.prepareGeneration(s,7999,'early'),false);assert.equal(g.prepareGeneration(s,8000,'batch'),true);
  assert.deepEqual(s.elements.filter(e=>e.status==='preparing').map(e=>[e.kind,e.concept]),[['background','underwater'],['prop','chicken']]);
  assert.deepEqual(h.activeCardPhysics(s.cardSlots),{mode:'water',effects:['grow']});
});
test('motion-only cards create no material, duplicate cards use one material, appearances alter keys',()=>{
  const s=room();put(s,'dance',0,1000);assert.deepEqual(g.cardVisualActions(s),[]);
  put(s,'chicken',1,1000);put(s,'chicken',2,1000);put(s,'golden',3,1000);
  assert.deepEqual(g.cardVisualActions(s).map(a=>a.concept),['golden chicken']);
});
test('conversation and cards share requests; failed or unknown paid requests are not retried',()=>{
  const s=room();put(s,'underwater',0,1000);put(s,'chicken',1,1000);
  const rest=g.queueConversationVisuals(s,{actions:[{type:'prop',concept:'a bird chicken',sourceCardIds:['chicken'],count:1,effects:[],targetId:''}]},2000);
  assert.deepEqual(rest.actions,[]);assert.equal(s.generation.dueAt,5000);g.prepareGeneration(s,5000,'one');
  assert.equal(s.elements.filter(e=>e.status==='preparing').length,2);
  for(const e of s.elements.filter(e=>e.status==='preparing')){e.status='failed';e.requestedAt=5000;s.generation.attempted.push(g.visualKey(e.kind,e.concept));}
  s.generation.running=undefined;put(s,'dance',2,6000);g.prepareGeneration(s,10000,'two');assert.equal(s.elements.filter(e=>e.status==='preparing').length,0);
});
test('latest environment wins, no migration work and generated material is reused',()=>{
  const s=room();assert.equal(s.generation,undefined);put(s,'underwater',0,1000);put(s,'space',1,2000);
  assert.equal(g.cardVisualActions(s)[0].concept,'outer space');
  s.elements.push({id:'saved',kind:'background',concept:'outer space',sourceCardIds:['space'],count:1,effects:[],assetUrl:'/saved.png',status:'displayed',reinforcedAt:1000});
  g.prepareGeneration(s,6000,'reuse');assert.equal(s.desiredBackgroundId,'saved');assert.equal(s.elements.filter(e=>e.status==='preparing').length,0);
});

const compiled=await build({entryPoints:['worker/worldWorker.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
async function fixture(){
  const calls=[];let hold,release;let permission=true;
  // Test-only control surface. Never included in either deployed Worker.
  const script=compiled.outputFiles[0].text+`
export class TestRoom extends WorldRoom {
 async fetch(r){const path=new URL(r.url).pathname;
 if(path==='/test'){const input=await r.json();const rows=this.ctx.storage.sql.exec('SELECT state FROM world WHERE id=1').toArray();const s=JSON.parse(rows[0].state);
 if(input.card){let row=this.ctx.storage.sql.exec('SELECT data FROM hands WHERE actor=?','p').toArray()[0];let hand=JSON.parse(row.data);hand.cards[0].cardId=input.card;this.ctx.storage.sql.exec('UPDATE hands SET data=? WHERE actor=?',JSON.stringify(hand),'p');}
 if(input.due&&s.generation){s.generation.dueAt=0;s.generation.blockedUntil=0;}
 if(input.expire&&s.generation?.running)s.generation.running.startedAt=Date.now()-181000;
 this.ctx.storage.sql.exec('UPDATE world SET state=? WHERE id=1',JSON.stringify(s));return Response.json(s);}
 if(path==='/tick'){await this.alarm();return new Response('ok');}return super.fetch(r);}
}
`;
  const executor=`import {WorkerEntrypoint} from 'cloudflare:workers';export class Executor extends WorkerEntrypoint {
 async visualPermission(){return (await (await fetch('https://fixture/permission')).json()).enabled;}
 async visual(input){return (await fetch('https://fixture/visual',{method:'POST',body:JSON.stringify(input)})).json();}
 async conversation(){return {text:'',emotion:'neutral',durationMs:1,worldIntent:{actions:[]}};}
} export default {fetch(){return new Response('ok')}};`;
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'room',modules:true,script,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],bindings:{SHARED_HAND_ENABLED:'true',SHARED_CONVERSATION_ENABLED:'true'},durableObjects:{ROOM:{className:'TestRoom',useSQLite:true}},serviceBindings:{WORLD_EXECUTOR:{name:'executor',entrypoint:'Executor'}}},{name:'executor',modules:true,script:executor,compatibilityDate:'2026-09-07',outboundService:async request=>{
    if(new URL(request.url).pathname==='/permission')return Response.json({enabled:permission});
    const input=await request.json();calls.push(input);if(hold&&input.element.kind==='background')await hold;
    return Response.json({assetUrl:'/fixture-'+input.element.concept+'.png'});
  }}]}));
  const ns=await mf.getDurableObjectNamespace('ROOM','room'),stub=ns.get(ns.idFromName('test'));
  const call=async(body,path='/')=>{const response=await stub.fetch('https://world'+path,{method:'POST',headers:{'X-World-Actor':'p','X-World-Role':body.op==='create'||body.op==='control'?'admin':'guest'},body:JSON.stringify(body)});return {status:response.status,value:await response.json()};};
  await call({op:'create',roomId:'test'});await call({op:'join'});
  const response=await stub.fetch('https://world/events',{headers:{Upgrade:'websocket','X-World-Actor':'p','X-World-Role':'guest'}});response.webSocket.accept();
  await call({op:'presence',visitor:'visitor',session:'session'});
  const insert=async(card,index=0)=>{await call({card},'/test');const {value:s}=await call({op:'state'});const input={op:'insert',eventId:crypto.randomUUID(),epoch:s.epoch,handCardId:s.hand[0].id,slotId:s.cardSlots[index].id,slotVersion:s.cardSlots[index].version};const result=await call(input);assert.equal(result.status,200);return input;};
  const tick=async()=>{await call({due:true},'/test');await stub.fetch('https://world/tick');};
  let closed=false;const disconnect=()=>{if(!closed){closed=true;response.webSocket.close();}};
  return {calls,call,insert,tick,hold:()=>{hold=new Promise(r=>release=r);},release:()=>{release?.();hold=undefined;},permission:value=>{permission=value;},disconnect,close:async()=>{release?.();disconnect();await mf.dispose();}};
}
async function until(condition){for(let i=0;i<80;i++){if(await condition())return;await new Promise(r=>setTimeout(r,25));}assert.fail('condition timed out');}
test('room: one card, no immediate provider; duplicate/rejected events preserve deadline',async()=>{
  const f=await fixture();try{const input=await f.insert('underwater');assert.equal(f.calls.length,0);
    const before=(await f.call({},'/test')).value.generation.dueAt;await f.call(input);await f.call({...input,eventId:'conflict'});
    assert.equal((await f.call({},'/test')).value.generation.dueAt,before);
    await f.tick();await until(()=>f.calls.length===1);assert.equal(f.calls[0].element.concept,'underwater');
    await until(async()=>!(await f.call({},'/test')).value.generation.running);
    await f.tick();assert.equal(f.calls.length,1);
  }finally{await f.close();}
});
test('room: background delay does not block props; running changes coalesce and old background cannot win',async()=>{
  const f=await fixture();try{f.hold();await f.insert('underwater');await f.insert('chicken',1);await f.tick();await until(()=>f.calls.length===2);
    await f.insert('space');await f.insert('gigantic',2);await f.tick();assert.equal(f.calls.length,2);
    f.release();await until(async()=>!(await f.call({},'/test')).value.generation.running);await f.tick();await until(()=>f.calls.length===3);
    assert.equal(f.calls[2].element.concept,'outer space');const s=(await f.call({},'/test')).value;
    assert.equal(s.elements.find(e=>e.concept==='underwater').error,'superseded');assert.equal(f.calls.filter(c=>c.element.kind==='prop').length,1);
  }finally{await f.close();}
});
test('room: generation off, no people, reset and unknown completion do not replay paid work',async()=>{
  const f=await fixture();try{f.permission(false);await f.insert('underwater');await f.tick();assert.equal(f.calls.length,0);
    f.permission(true);f.hold();await f.tick();await until(()=>f.calls.length===1);
    await f.call({op:'control',action:'reset'});f.release();await new Promise(r=>setTimeout(r,100));assert.equal((await f.call({op:'state'})).value.elements.length,0);
  }finally{await f.close();}
  const absent=await fixture();try{await absent.insert('space');absent.disconnect();await absent.tick();await new Promise(r=>setTimeout(r,100));assert.equal(absent.calls.length,0);}finally{await absent.close();}
});
test('room: unknown paid completion is fenced and never automatically resubmitted',async()=>{
  const f=await fixture();try{f.hold();await f.insert('underwater');await f.tick();await until(()=>f.calls.length===1);
    await f.call({expire:true},'/test');await f.tick();const s=(await f.call({},'/test')).value;assert.equal(s.elements.find(e=>e.kind==='background').error,'generation_interrupted');
    f.release();await new Promise(r=>setTimeout(r,100));await f.tick();assert.equal(f.calls.length,1);assert.equal((await f.call({},'/test')).value.elements.find(e=>e.kind==='background').status,'failed');
  }finally{await f.close();}
});
test('room: image load failure does not claim display or invalidate another viewer',async()=>{
  const f=await fixture();try{await f.insert('underwater');await f.tick();await until(async()=>(await f.call({op:'state'})).value.elements.some(e=>e.kind==='background'&&e.status==='ready'));
    const s=(await f.call({op:'state'})).value;const e=s.elements.find(e=>e.kind==='background');
    const failure=await f.call({op:'display',elementId:e.id,status:'load_failed',epoch:s.epoch});assert.equal(failure.value.elements.find(x=>x.id===e.id).status,'ready');assert.notEqual(failure.value.displayedWorld.location,'underwater');
    const shown=await f.call({op:'display',elementId:e.id,status:'displayed',epoch:s.epoch});assert.equal(shown.value.displayedWorld.location,'underwater');
  }finally{await f.close();}
});
