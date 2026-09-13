import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
const load=async path=>{const b=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
const hand=await load('src/sharedWorld/hand.ts'),world=await load('src/sharedWorld/state.ts');
test('repeated speech cards are accepted only for the trusted shared path',async()=>{
  const {readChatRequest}=await load('server/chatValidation.ts');
  const input={mode:'manual',message:'こんにちは',history:[],brainCardIds:Array(5).fill('chicken'),forcedCardId:null,recentExpressionLevels:[]};
  assert.throws(()=>readChatRequest(input),/duplicates/);assert.deepEqual(readChatRequest(input,true).brainCardIds,input.brainCardIds);
});
test('duplicate hand identities, one-card refill and three weighted draws',()=>{
  const h=hand.createHand(4,()=>0);assert.equal(h.cards.length,5);assert.equal(new Set(h.cards.map(c=>c.id)).size,5);assert.equal(new Set(h.cards.map(c=>c.cardId)).size,1);
  const id=h.cards[0].id;const cardId=h.cards[0].cardId;hand.consumeHand(h,id,()=>0);assert.equal(h.cards.length,5);assert.ok(!h.cards.some(c=>c.id===id));assert.equal(h.boosts[cardId],2);
  // First card occupies 6/55 of the boosted deck, rather than 1/50.
  assert.equal(hand.drawCard(h,()=>.08).cardId,cardId);assert.equal(h.boosts[cardId],1);hand.drawCard(h,()=>.08);assert.equal(h.boosts[cardId],undefined);assert.notEqual(hand.drawCard(h,()=>.08).cardId,cardId);
});
const add=(s,id,i,now=100000)=>world.insertWorldCard(s,{cardId:id,eventId:`event-${i}`,participant:'p',name:'P'},now);
test('migration preserves ordered duplicates and does not trigger a match',()=>{
  const s=world.createSharedWorld('room');for(let i=0;i<5;i++)add(s,'chicken',i);hand.ensureCardSlots(s);
  assert.equal(s.cardSlots.length,5);assert.equal(s.matchingCardId,'chicken');assert.equal(s.matchBonus,undefined);assert.equal(hand.ensureCardSlots(s),false);
  const c=JSON.parse(world.sharedWorldContext(s,100000));assert.equal(c.activeCounts.chicken,5);assert.equal(c.activeSlots.length,5);
});
test('matching is an edge with independent cooldown and no delayed trigger',()=>{
  const s=world.createSharedWorld('room');hand.ensureCardSlots(s);
  const put=(i,id,at)=>{add(s,id,++s.sequence,at);hand.updateCardSlot(s,s.cardSlots[i],id,`match-${s.sequence}`,at);};
  for(let i=0;i<5;i++)put(i,'chicken',100000);const first=s.matchBonus.id;assert.equal(s.chaos,null);
  put(0,'chicken',200000);assert.equal(s.matchBonus.id,first);
  put(0,'crab',200001);put(0,'chicken',200002);assert.notEqual(s.matchBonus.id,first);const second=s.matchBonus.id;
  put(0,'crab',200003);put(0,'chicken',200004);assert.equal(s.matchBonus.id,second);put(0,'chicken',300000);assert.equal(s.matchBonus.id,second);
});
test('active rules follow slot order and late intents cannot resurrect ejected rules',()=>{
  const s=world.createSharedWorld('room');add(s,'underwater',1);add(s,'zero-gravity',2);hand.ensureCardSlots(s);
  assert.equal(hand.activeCardPhysics(s.cardSlots).mode,'zero');s.cardSlots[1].cardId='chicken';assert.equal(hand.activeCardPhysics(s.cardSlots).mode,'water');
  s.cardSlots[0].cardId='chicken';assert.equal(hand.activeCardPhysics(s.cardSlots).mode,'normal');
  world.applyWorldIntent(s,{actions:[{type:'physics',targetId:'',concept:'zero',sourceCardIds:['zero-gravity'],effects:['float'],count:1},{type:'prop',targetId:'',concept:'crab',sourceCardIds:['zero-gravity'],effects:['float','dance'],count:1}]},'late',200000);
  assert.equal(s.physics,undefined);assert.deepEqual(s.elements[0].effects,['dance']);
  add(s,'chicken',3);s.elements[0].status='displayed';world.applyWorldIntent(s,{actions:[{type:'physics',targetId:s.elements[0].id,concept:'zero',sourceCardIds:['chicken'],effects:[],count:1}]},'intrinsic',200001);assert.ok(s.elements[0].effects.includes('float'));
});
test('every card has a stable match presentation',async()=>{const {cardPool}=await load('src/cards/cardPool.ts');const {worldMatchPresentation}=await load('src/sharedWorld/cards.ts');assert.equal(cardPool.length,50);for(const card of cardPool){const p=worldMatchPresentation(card);assert.equal(p.label,card.label);assert.ok(p.icon);assert.ok(Number.isFinite(p.hue));}});
test('gravity removal preserves position and transitions before falling',async()=>{
  const {WorldPhysics}=await load('src/sharedWorld/physics.ts');const p=new WorldPhysics();p.resize(500,600);p.sync([{id:'a',x:200,y:200,size:50,effects:[]}]);for(let i=0;i<120;i++)p.step(1000/60,'zero');
  const body=p.bodies.get('a').body;const before={...body.position};p.step(1000/60,'normal');assert.ok(Math.abs(body.position.y-before.y)<5);
  for(let i=0;i<240;i++)p.step(1000/60,'normal');assert.ok(body.position.y>before.y+100);p.dispose();
});
test('50 clients: private hands, atomic conflicts, replay, rejection, reconnect and reset',async()=>{
  const b=await build({entryPoints:['worker/worldWorker.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
  const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:b.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],bindings:{SHARED_HAND_ENABLED:'true'},durableObjects:{ROOM:{className:'WorldRoom',useSQLite:true}}}));
  const sockets=[];
  try{const ns=await mf.getDurableObjectNamespace('ROOM');const room=ns.get(ns.idFromName('room'));
    const call=async(actor,body,role='guest')=>{const r=await room.fetch('https://world/',{method:'POST',headers:{'X-World-Actor':actor,'X-World-Role':role},body:JSON.stringify(body)});return {status:r.status,value:await r.json()};};
    await call('admin',{op:'create',roomId:'room'},'admin');const people=await Promise.all(Array.from({length:50},(_,i)=>call(`p${i}`,{op:'join'})));assert.ok(people.every(p=>p.value.hand.length===5));
    const ids=people.flatMap(p=>p.value.hand.map(c=>c.id));assert.equal(new Set(ids).size,250);
    const snapshots=[];
    for(let i=0;i<50;i++){const r=await room.fetch('https://world/events',{headers:{Upgrade:'websocket','X-World-Actor':`p${i}`,'X-World-Role':'guest'}});assert.equal(r.status,101);r.webSocket.addEventListener('message',event=>{snapshots[i]=JSON.parse(event.data);});r.webSocket.accept();sockets.push(r.webSocket);}
    const inserts=people.map((p,i)=>({op:'insert',epoch:0,eventId:`event-${i}`,handCardId:p.value.hand[0].id,slotId:'slot-0',slotVersion:0}));
    const results=await Promise.all(inserts.map((input,i)=>call(`p${i}`,input)));assert.equal(results.filter(r=>r.value.accepted!==false).length,1);
    const winner=results.findIndex(r=>r.value.accepted!==false);const won=results[winner].value;assert.equal(won.sequence,1);assert.equal(won.hand.length,5);assert.ok(!won.hand.some(c=>c.id===inserts[winner].handCardId));
    const again=(await call(`p${winner}`,inserts[winner])).value;assert.equal(again.sequence,1);assert.deepEqual(again.hand,won.hand);
    const loser=(winner+1)%50;assert.deepEqual(results[loser].value.hand,people[loser].value.hand);
    const reconnect=(await call(`p${winner}`,{op:'join'})).value;assert.deepEqual(reconnect.hand,won.hand);assert.ok(!JSON.stringify(reconnect).includes(people[loser].value.hand[0].id));
    await new Promise(resolve=>setTimeout(resolve,20));assert.equal(snapshots.length,50);assert.ok(snapshots.every(s=>s.sequence===1));assert.deepEqual(snapshots[loser].hand,people[loser].value.hand);
    assert.equal((await call('p0',{op:'card',epoch:0,eventId:'bypass',cardId:'chicken'})).status,409);
    const stolen=await call(`p${loser}`,{...inserts[loser],eventId:'stolen',slotVersion:1,handCardId:won.hand[0].id});assert.equal(stolen.status,409);
    const resetHand={op:'hand-reset',epoch:0,eventId:'next'};const next=(await call(`p${winner}`,resetHand)).value;assert.notDeepEqual(next.hand,won.hand);assert.deepEqual((await call(`p${winner}`,resetHand)).value.hand,next.hand);assert.deepEqual(next.cardSlots,won.cardSlots);
    await call('admin',{op:'control',action:'reset'},'admin');const reset=(await call('p0',{op:'state'})).value;assert.equal(reset.epoch,1);assert.ok(reset.cardSlots.every(s=>s.cardId===null));assert.equal((await call(`p${winner}`,inserts[winner])).status,409);
  }finally{for(const socket of sockets)socket.close();await mf.dispose();}
});
