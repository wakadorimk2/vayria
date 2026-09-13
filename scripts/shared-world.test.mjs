import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createHmac} from 'node:crypto';

const moduleBundle=await build({entryPoints:['src/sharedWorld/state.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const state=await import('data:text/javascript;base64,'+Buffer.from(moduleBundle.outputFiles[0].text).toString('base64'));
const cardsBundle=await build({entryPoints:['src/cards/cardPool.ts'],bundle:true,write:false,format:'esm',platform:'node'});
const {cardPool}=await import('data:text/javascript;base64,'+Buffer.from(cardsBundle.outputFiles[0].text).toString('base64'));
const bundle=await build({entryPoints:['worker/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
const key='shared-world-fixture-not-a-secret';
const signed=payload=>{const b=Buffer.from(JSON.stringify(payload)).toString('base64url');return b+'.'+createHmac('sha256',key).update(b).digest('base64url');};
const add=(s,cardId,index,now=100000)=>state.insertWorldCard(s,{cardId,eventId:`e${index}`,participant:'p1',name:'参加者1'},now);

test('same conversation call returns composable world intent for JSON and speech streams',async()=>{
  const generated=await build({entryPoints:['worker/generation.ts'],bundle:true,write:false,format:'esm',platform:'node'});
  const {mkdir,writeFile}=await import('node:fs/promises');await mkdir('node_modules/.tmp/shared-world',{recursive:true});await writeFile('node_modules/.tmp/shared-world/generation.mjs',generated.outputFiles[0].text);
  const {generate}=await import('../node_modules/.tmp/shared-world/generation.mjs');
  const previous=globalThis.fetch;let calls=0;const s=state.createSharedWorld('room');add(s,'crab',1);add(s,'dance',2);add(s,'zero-gravity',3);
  const intent={actions:[{type:'prop',concept:'crab',targetId:'',sourceCardIds:['crab','dance','zero-gravity'],effects:['dance','float'],count:3}]};
  globalThis.fetch=async(url,init)=>{
    assert.equal(new URL(url).hostname,'api.openai.com');calls++;const body=JSON.parse(init.body);const properties=body.text.format.schema.properties;
    assert.ok(properties.worldIntent);assert.equal(properties.visualIntent,undefined);
    const streaming=!!properties.deliveryHeader;
    const response=streaming?{worldIntent:intent,deliveryHeader:{voiceAction:'take_floor',backchannelCue:'none',emotion:'neutral',speechAct:'answer',expressionLevel:'low'},speechLead:'',speechUnits:['カニを踊らせてみるね。'],activatedCards:['chicken']}:{worldIntent:intent,voiceAction:'take_floor',backchannelCue:'none',text:'カニを踊らせてみるね。',emotion:'neutral',speechAct:'answer',expressionLevel:'low',activatedCards:['chicken']};
    return new Response([{type:'response.output_text.delta',delta:JSON.stringify(response)},{type:'response.completed',response:{model:'gpt-5-nano',usage:{input_tokens:10,output_tokens:10},service_tier:'default'}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
  };
  try{for(const streaming of [false,true]){
    const before=calls;const speech=[];
    const response=await generate({mode:'voice',message:'カニを踊らせて',history:[],recentExpressionLevels:[],brainCardIds:['chicken','suspicious','sleepy','rain','gigantic'],forcedCardId:null,performanceContext:{callbackTendency:0,fragmentation:0,semanticBiases:[]},earlySpeechLead:false},false,'fixture',new AbortController().signal,streaming?{onSpeechUnit:(_i,text)=>speech.push(text),onStateRejected:()=>{},onDeliveryMetadataRejected:()=>{}}:null,undefined,false,false,true);
    assert.deepEqual(response.worldIntent,intent);assert.equal(calls-before,1);if(streaming)assert.ok(speech.length);
  }}finally{globalThis.fetch=previous;}
});

test('50 unique cards and normal accumulation never create a generated object',()=>{
  assert.equal(cardPool.length,50);assert.equal(new Set(cardPool.map(c=>c.id)).size,50);
  const s=state.createSharedWorld('room');add(s,'chicken',1);add(s,'chicken',1);assert.equal(s.weights.chicken.total,1);assert.equal(s.elements.length,0);
  add(s,'dance',2);add(s,'zero-gravity',3);const context=JSON.parse(state.sharedWorldContext(s,100000));
  assert.deepEqual(context.recentOrder.map(x=>x.cardId),['chicken','dance','zero-gravity']);assert.equal(context.cards.length,3);
});
test('threshold fires once, aggregates repeats and keeps quantity bounded in a flock',()=>{
  const s=state.createSharedWorld('room');for(let i=0;i<100;i++)add(s,'chicken',i,100000+i);
  assert.equal(s.elements.length,1);assert.equal(s.elements[0].count,100);assert.equal(s.chaos.id,'e9');assert.equal(s.elements[0].status,'ready');assert.equal(s.elements[0].assetUrl,undefined);
});
test('minority composition, effects, duplicates, displayed boundary and elapsed-time decay',()=>{
  const s=state.createSharedWorld('room');for(const [i,c] of ['crab','dance','zero-gravity'].entries())add(s,c,i);
  const intent={actions:[{type:'prop',concept:'crab',targetId:'',sourceCardIds:['crab','dance','zero-gravity'],effects:['dance','float'],count:3}]};
  state.applyWorldIntent(s,intent,'turn1',100000);assert.equal(s.elements[0].status,'preparing');assert.equal(s.displayedWorld.props.length,0);
  state.applyWorldIntent(s,intent,'turn1',100000);assert.equal(s.elements.length,1);
  s.elements[0].status='displayed';state.applyWorldIntent(s,{actions:[{...intent.actions[0],type:'duplicate',targetId:s.elements[0].id,count:7}]},'turn2',100000);
  assert.equal(s.elements[0].count,10);assert.deepEqual(s.elements[0].effects,['dance','float']);
  assert.equal(state.elementStage(s.elements[0],280000),'background');assert.equal(state.elementStage(s.elements[0],1900000),'trace');
  assert.equal(state.traceWeight(s.elements[0],88300000),.5);assert.equal(state.cardWeight(s.weights.crab,280000),.5);
  assert.throws(()=>state.applyWorldIntent(s,{actions:[{...intent.actions[0],sourceCardIds:['cat']}]},'bad',100000));
  s.elements[0].assetUrl='/api/world-room/room/media/crab';
  state.applyWorldIntent(s,{actions:[{...intent.actions[0],effects:['grow'],count:1}]},'giant',100000);
  assert.equal(s.elements.length,2);assert.equal(s.elements[1].count,1);
  assert.equal(s.elements[1].status,'ready');assert.equal(s.elements[1].assetUrl,s.elements[0].assetUrl);
  assert.deepEqual(s.elements[0].effects,['dance','float']);
});
test('history compacts while totals persist, and context fits the existing contract',()=>{
  const s=state.createSharedWorld('room');for(let i=0;i<10002;i++)add(s,'quiet',i,100000+i);
  assert.equal(s.history.length,10000);assert.equal(s.weights.quiet.total,10002);assert.equal(s.daily['1970-01-01'].quiet,2);
  for(const [i,c]of cardPool.entries())add(s,c.id,20000+i);
  s.elements=Array.from({length:128},(_,i)=>({id:'x'.repeat(70)+i,concept:'long concept '.repeat(12),sourceCardIds:cardPool.slice(0,8).map(c=>c.id),effects:['dance','float','grow','slide','sparkle','glow'],kind:'prop',count:1000,status:'displayed',reinforcedAt:100000}));
  assert.ok(state.sharedWorldContext(s,200000).length<=12000);
  assert.equal(JSON.parse(state.sharedWorldContext(s,200000)).cards.length,50);
});

async function fixture(){const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'world',modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],
  durableObjects:{USAGE:{className:'PublicUsage',useSQLite:true},WORLD_ROOMS:{className:'WorldRoom',useSQLite:true}},
  bindings:{COOKIE_SECRET:key,ADMIN_SECRET:key,SHARED_WORLD_ENABLED:'true',GENERATION_ENABLED:'false',REQUIRE_PREVIEW_ACCESS:'false'},
  serviceBindings:{ASSETS:()=>new Response('fixture',{headers:{'Content-Type':'text/html'}})},r2Buckets:['VISUAL_ASSETS']}]}));
  const origin='https://test.example';const request=(path,body,cookie='',headers={})=>mf.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...headers},body:body?JSON.stringify(body):undefined});
  const admin={Authorization:'Bearer '+signed({purpose:'admin',exp:Date.now()+600000})};
  const created=await request('/api/admin',{op:'world-create',roomId:'room'},'',admin);assert.equal(created.status,200);const links=await created.json();
  const join=async(host=false)=>{const link=new URL(host?links.hostUrl:links.joinUrl);const grant=new URLSearchParams(link.hash.slice(1)).get(host?'host':'invite');const r=await request('/api/world-room/room/join',{grant});assert.equal(r.status,200);return r.headers.get('Set-Cookie').split(';')[0];};
  return {mf,request,admin,join};
}
test('50 participants share exact counts; dedup, guest authorization and hibernation socket snapshots',async()=>{
  const f=await fixture();const sockets=[];
  try{
    const guests=await Promise.all(Array.from({length:50},()=>f.join()));
    for(const guest of guests){const r=await f.mf.dispatchFetch('https://test.example/api/world-room/room/events',{headers:{Upgrade:'websocket',Origin:'https://test.example',Cookie:guest}});assert.equal(r.status,101);r.webSocket.accept();sockets.push(r.webSocket);}
    const responses=await Promise.all(guests.map((cookie,i)=>f.request('/api/world-room/room/card',{eventId:`input${i}`,cardId:'chicken',epoch:0},cookie)));
    assert.ok(responses.every(r=>r.status===200));
    const repeat=await f.request('/api/world-room/room/card',{eventId:'input0',cardId:'chicken',epoch:0},guests[0]);assert.equal((await repeat.json()).duplicate,true);
    const snapshot=await(await f.request('/api/world-room/room/state',null,guests[0])).json();assert.equal(snapshot.weights.chicken.total,50);assert.equal(snapshot.elements.length,1);assert.equal(snapshot.elements[0].count,50);assert.ok(!('assetUrl' in snapshot.elements[0]));
    for(const path of ['/api/chat','/api/visual/generate','/api/tts','/api/world-room/room/lease','/api/world-room/room/prepare','/api/world-room/room/element'])assert.equal((await f.request(path,{},guests[0])).status,403,path);
    assert.equal((await f.request('/api/world-room/room/card',{eventId:'old',cardId:'crab',epoch:9},guests[0])).status,409);
  }finally{for(const s of sockets)s.close();await f.mf.dispose();}
});
test('host takeover and reset fence obsolete work; guest burst is limited',async()=>{
  const f=await fixture();try{
    const host=await f.join(true);const a=await(await f.request('/api/world-room/room/lease',{clientId:'a'},host)).json();
    assert.equal((await f.request('/api/world-room/room/lease',{clientId:'b'},host)).status,409);
    const b=await(await f.request('/api/world-room/room/lease',{clientId:'b',takeover:true},host)).json();assert.notEqual(a.token,b.token);
    const headers={'X-World-Client':'a','X-World-Lease':a.token,'X-World-Epoch':'0'};
    assert.equal((await f.request('/api/world-room/room/element',{elementId:'x',status:'displayed'},host,headers)).status,403);
    const guest=await f.join();const responses=await Promise.all(Array.from({length:15},(_,i)=>f.request('/api/world-room/room/card',{eventId:`burst${i}`,cardId:'quiet',epoch:0},guest)));
    assert.ok(responses.some(r=>r.status===429));
    await f.request('/api/admin',{op:'world-control',roomId:'room',action:'reset'},'',f.admin);
    const next=await(await f.request('/api/world-room/room/state',null,guest)).json();assert.equal(next.epoch,1);assert.equal(Object.keys(next.weights).length,0);
    assert.equal((await f.request('/api/world-room/room/card',{eventId:'late',cardId:'cat',epoch:0},guest)).status,409);
  }finally{await f.mf.dispose();}
});

test('persistent generation claim, autonomous cooldown and new inputs preserve a pending result',async()=>{
  const f=await fixture();try{
    const namespace=await f.mf.getDurableObjectNamespace('WORLD_ROOMS');const room=namespace.get(namespace.idFromName('room'));
    const call=body=>room.fetch('https://world/',{method:'POST',headers:{'X-World-Actor':'host','X-World-Role':'host'},body:JSON.stringify(body)});
    const lease=await(await call({op:'lease',clientId:'host'})).json();const auth={clientId:'host',lease:lease.token,epoch:0};
    await call({op:'card',eventId:'crab1',cardId:'crab',epoch:0});
    assert.equal((await call({op:'decision',...auth,decisionId:'turn',autonomous:true})).status,200);
    assert.equal((await call({op:'decision',...auth,decisionId:'turn2',autonomous:true})).status,429);
    await call({op:'intent',...auth,decisionId:'turn',intent:{actions:[{type:'prop',targetId:'',concept:'crab',sourceCardIds:['crab'],effects:['dance'],count:3}]}});
    assert.equal((await call({op:'claim',...auth,elementId:'turn-0'})).status,200);
    assert.equal((await call({op:'claim',...auth,elementId:'turn-0'})).status,409);
    await call({op:'card',eventId:'crab2',cardId:'crab',epoch:0});
    assert.equal((await call({op:'element',...auth,elementId:'turn-0',status:'ready',assetUrl:'/world/crab'})).status,200);
    let snapshot=await(await call({op:'state'})).json();assert.equal(snapshot.displayedWorld.props.length,0);
    await call({op:'element',...auth,elementId:'turn-0',status:'displayed'});
    snapshot=await(await call({op:'state'})).json();assert.equal(snapshot.displayedWorld.props.length,1);assert.equal(snapshot.weights.crab.total,2);
    await f.request('/api/admin',{op:'world-control',roomId:'room',action:'reset'},'',f.admin);
    assert.equal((await call({op:'element',...auth,elementId:'turn-0',status:'ready',assetUrl:'/world/crab'})).status,403);
  }finally{await f.mf.dispose();}
});
