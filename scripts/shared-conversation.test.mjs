import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {createHmac} from 'node:crypto';
const load=async(path)=>{const b=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
const queue=await load('src/sharedWorld/conversation.ts');
const state=await load('src/sharedWorld/state.ts');
const slot=(id,actor=id)=>({id,actor,visitor:actor,session:'session-'+actor,kind:'text',text:'こんにちは'});
test('FIFO, bounded waiting, idempotency, cooldown and expired/disconnected reservations',()=>{
  const c=queue.createRoomConversation();queue.reserveConversation(c,slot('a'),1000);
  queue.reserveConversation(c,slot('a'),1000);assert.equal(c.active.id,'a');assert.equal(c.queue.length,0);
  assert.throws(()=>queue.reserveConversation(c,slot('again','a'),5000),/already_waiting/);
  for(let i=0;i<10;i++)queue.reserveConversation(c,slot('w'+i),1001+i);
  assert.throws(()=>queue.reserveConversation(c,slot('full'),2000),/conversation_full/);
  queue.cancelConversation(c,'a','a');queue.advanceConversation(c,2000);assert.equal(c.active.id,'w0');
  queue.cancelConversation(c,'w0','w0');assert.throws(()=>queue.reserveConversation(c,slot('again','w0'),2000),/cooldown/);
  queue.advanceConversation(c,200000);assert.equal(c.active,null);assert.equal(c.queue.length,0);
  queue.reserveConversation(c,slot('voice'),201000);queue.advanceConversation(c,201001,new Set());assert.equal(c.active,null);
});
test('one decision fans out to background and room physics; invalid targets are atomic',()=>{
  const s=state.createSharedWorld('room');state.insertWorldCard(s,{eventId:'e',participant:'p',name:'P',cardId:'underwater'},1000);
  const action={type:'background',targetId:'',concept:'underwater',sourceCardIds:['underwater'],effects:[],count:1};
  const intent={actions:[action,{...action,type:'physics',concept:'water'}]};assert.ok(state.readWorldIntent(intent));
  state.applyWorldIntent(s,intent,'turn',2000);assert.equal(s.physics.mode,'water');assert.equal(s.elements.length,1);assert.equal(s.elements[0].status,'preparing');
  const before=JSON.stringify(s);assert.throws(()=>state.applyWorldIntent(s,{actions:[action,{...action,type:'physics',concept:'zero',targetId:'missing'}]},'bad',3000));assert.equal(JSON.stringify(s),before);
});
test('local physics collides, sleeps, floats, dances and releases background bodies',async()=>{
  const {WorldPhysics}=await load('src/sharedWorld/physics.ts');const p=new WorldPhysics();p.resize(600,600);
  p.sync([{id:'a',x:300,y:100,size:70,effects:[]},{id:'b',x:300,y:10,size:70,effects:[]}]);
  for(let i=0;i<900;i++)p.step(1000/60,'normal');
  const a=p.bodies.get('a').body,b=p.bodies.get('b').body;
  assert.ok(a.position.y<600&&b.position.y<600);assert.ok(Math.hypot(a.position.x-b.position.x,a.position.y-b.position.y)>50);
  const before=a.position.y;for(let i=0;i<300;i++)p.step(1000/60,'zero',['dance']);assert.ok(Math.abs(a.position.y-before)>20);
  p.sync([]);assert.equal(p.bodies.size,0);p.dispose();
});

const app=await build({entryPoints:['worker/shared/index.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
const storage=await build({entryPoints:['worker/worldWorker.ts'],bundle:true,write:false,format:'esm',platform:'node',external:['cloudflare:workers']});
const key='room-conversation-fixture-not-a-secret';
const signed=payload=>{const b=Buffer.from(JSON.stringify(payload)).toString('base64url');return b+'.'+createHmac('sha256',key).update(b).digest('base64url');};
async function fixture({holdModel,intent}={}){
  const calls=[];
  const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'public',modules:true,script:app.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],
    durableObjects:{USAGE:{className:'PublicUsage',useSQLite:true},WORLD_ROOMS:{className:'WorldRoom',scriptName:'storage',useSQLite:true}},
    bindings:{SHARED_WORLD_ENABLED:'true',SHARED_CONVERSATION_ENABLED:'true',COOKIE_SECRET:key,IP_SECRET:key,ADMIN_SECRET:key,GENERATION_ENABLED:'true',MANIFESTATION_ENABLED:'true',VISUAL_CACHE_ONLY:'true',VISUAL_BACKGROUND_ENABLED:'true',REQUIRE_PREVIEW_ACCESS:'false',PUBLIC_HOSTNAME:'test.example',OPENAI_API_KEY:'fixture',AIVIS_API_KEY:'fixture',AIVIS_MODEL_UUID:'7fc08a41-b64d-456d-8b22-8e1284674775',AIVIS_SPEAKER_UUID:'8e2dfde9-a155-4bd8-b451-80832ad5e8ac'},
    serviceBindings:{ASSETS:()=>new Response('scene')},r2Buckets:['VISUAL_ASSETS'],
    outboundService:async request=>{const path=new URL(request.url).pathname;calls.push(path);
      if(path.endsWith('/siteverify'))return Response.json({success:true,hostname:'test.example',action:'session'});
      if(path==='/v1/responses'){
        if(holdModel)await holdModel;
        const body=await request.json();const properties=body.text.format.schema.properties;assert.ok(properties.worldIntent);assert.equal(properties.visualIntent,undefined);
        const result={text:'カニが気になるね。',emotion:'neutral',activatedCards:['chicken'],interactionAction:'take_floor',voiceAction:'take_floor',backchannelCue:'none',speechAct:'answer',expressionLevel:'low',worldIntent:intent??{actions:[]},externalAction:'none',usedReasonIds:[],internalDelta:{reasonUpdates:[]}};
        if(properties.externalAction){result.text='';result.activatedCards=[];result.speechAct=null;result.expressionLevel=null;}
        for(const field of Object.keys(result))if(!properties[field])delete result[field];
        return new Response([{type:'response.output_text.delta',delta:JSON.stringify(result)},{type:'response.completed',response:{model:'gpt-5-nano',usage:{input_tokens:10,output_tokens:10},service_tier:'default'}}].map(e=>'data: '+JSON.stringify(e)+'\n\n').join(''),{headers:{'Content-Type':'text/event-stream'}});
      }
      if(path==='/v1/tts/synthesize')return new Response(new Uint8Array([73,68,51]),{headers:{'Content-Type':'audio/mpeg'}});
      if(path==='/v1/audio/transcriptions')return Response.json({text:'こんにちは',usage:{input_tokens:1,output_tokens:1}});
      throw new Error('unexpected provider '+path);
    }},
    {name:'storage',modules:true,script:storage.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],bindings:{SHARED_CONVERSATION_ENABLED:'true'},durableObjects:{ROOM:{className:'WorldRoom',useSQLite:true}},serviceBindings:{WORLD_EXECUTOR:{name:'public',entrypoint:'WorldExecution'}}}]}));
  const origin='https://test.example';const request=(path,body,cookie='',headers={})=>mf.dispatchFetch(origin+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json','CF-Connecting-IP':'192.0.2.1',Cookie:cookie,...headers},body:body?JSON.stringify(body):undefined});
  const admin={Authorization:'Bearer '+signed({purpose:'admin',exp:Date.now()+600000})};
  const created=await request('/api/admin',{op:'world-create',roomId:'room'},'',admin);const links=await created.json();if(created.status!==200){await mf.dispose();assert.fail(JSON.stringify(links));}
  const join=async()=>{
    const grant=new URLSearchParams(new URL(links.joinUrl).hash.slice(1)).get('invite');
    const member=await request('/api/world-room/room/join',{grant});const cookie=member.headers.get('Set-Cookie').split(';')[0];
    const boot=await request('/api/session',null,cookie);assert.equal(boot.status,200);const cookies=cookie+'; '+boot.headers.get('Set-Cookie').split(';')[0];
    const admission=await request('/api/session',{token:crypto.randomUUID()},cookies);const admitted=await admission.json();assert.equal(admission.status,200,JSON.stringify(admitted));const id=admitted.session.id;
    return {cookie:cookies,headers:{'X-Vayria-Session':id}};
  };
  const snapshot=async person=>(await request('/api/world-room/room/state',null,person.cookie)).json();
  return {mf,request,join,calls,snapshot,admin};
}
test('hostless shared turn generates one LLM and one TTS; viewers reuse audio and raw APIs stay denied',async()=>{
  const f=await fixture();try{
    const a=await f.join(),b=await f.join();
    const post=()=>f.request('/api/world-room/room/conversation',{id:'turn-one',kind:'text',text:'こんにちは',epoch:0},a.cookie,a.headers);
    assert.equal((await post()).status,200);assert.equal((await post()).status,200);
    let snapshot;
    for(let i=0;i<100;i++){snapshot=await f.snapshot(b);if(snapshot.conversationView.reply)break;await new Promise(r=>setTimeout(r,20));}
    assert.ok(snapshot.conversationView.reply,JSON.stringify(snapshot.outcomes));
    assert.equal(snapshot.host,null);assert.equal(snapshot.conversation,undefined);
    assert.equal(f.calls.filter(p=>p==='/v1/responses').length,1);
    assert.equal(f.calls.filter(p=>p==='/v1/tts/synthesize').length,1);
    const url=snapshot.conversationView.reply.audioUrl;assert.ok(url);
    assert.equal((await f.request(url,null,a.cookie)).status,200);assert.equal((await f.request(url,null,b.cookie)).status,200);
    assert.equal(f.calls.filter(p=>p==='/v1/tts/synthesize').length,1);
    for(const path of ['/api/chat','/api/transcribe','/api/tts','/api/visual/generate'])assert.equal((await f.request(path,{},b.cookie,b.headers)).status,403);
    assert.equal((await f.request('/api/world-room/room/conversation',{id:'pending',kind:'voice',epoch:0},b.cookie,b.headers)).status,200);
    assert.equal((await f.snapshot(b)).conversationView.slot.status,'waiting');
    await f.request('/api/world-room/room/cancel',{id:'pending',epoch:0},b.cookie);
    assert.equal((await f.snapshot(b)).conversationView.slot,null);assert.equal(f.calls.includes('/v1/audio/transcriptions'),false);
    await f.request('/api/admin',{op:'world-control',roomId:'room',action:'reset'},'',f.admin);
    assert.equal((await f.snapshot(a)).conversationView.reply,null);
  }finally{await f.mf.dispose();}
});
test('voice slot requires grant before STT and duplicate uploads do not run another turn',async()=>{
  const f=await fixture();try{
    const a=await f.join();
    const response=await f.request('/api/world-room/room/conversation',{id:'voice-one',kind:'voice',epoch:0},a.cookie,a.headers);
    assert.equal(response.status,200);assert.equal((await response.json()).conversationView.slot.status,'granted');
    assert.equal(f.calls.includes('/v1/audio/transcriptions'),false);
    const audio=new ArrayBuffer(32044),view=new DataView(audio);
    const ascii=(i,s)=>{for(let j=0;j<s.length;j++)view.setUint8(i+j,s.charCodeAt(j));};
    ascii(0,'RIFF');view.setUint32(4,32036,true);ascii(8,'WAVE');ascii(12,'fmt ');view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);ascii(36,'data');view.setUint32(40,32000,true);
    const send=id=>f.mf.dispatchFetch('https://test.example/api/world-room/room/voice',{method:'POST',headers:{Origin:'https://test.example',Cookie:a.cookie,...a.headers,'X-World-Slot':id,'X-World-Epoch':'0','Content-Type':'audio/wav'},body:audio});
    assert.equal((await send('wrong')).status,403);assert.equal(f.calls.includes('/v1/audio/transcriptions'),false);
    assert.equal((await send('voice-one')).status,200);
    assert.equal((await send('voice-one')).status,403);
    let next;for(let i=0;i<100;i++){next=await f.snapshot(a);if(next.conversationView.reply)break;await new Promise(r=>setTimeout(r,20));}
    assert.ok(next.conversationView.reply,JSON.stringify(next.outcomes));assert.equal(f.calls.filter(p=>p==='/v1/audio/transcriptions').length,1);
    assert.equal(f.calls.filter(p=>p==='/v1/responses').length,1);
  }finally{await f.mf.dispose();}
});
test('reset fences a running response without restarting paid work',async()=>{
  let release;const holdModel=new Promise(r=>{release=r;});const f=await fixture({holdModel});try{
    const a=await f.join();await f.request('/api/world-room/room/conversation',{id:'slow',kind:'text',text:'こんにちは',epoch:0},a.cookie,a.headers);
    for(let i=0;i<100&&!f.calls.includes('/v1/responses');i++)await new Promise(r=>setTimeout(r,10));
    await f.request('/api/admin',{op:'world-control',roomId:'room',action:'reset'},'',f.admin);release();
    await new Promise(r=>setTimeout(r,100));const next=await f.snapshot(a);assert.equal(next.epoch,1);assert.equal(next.conversationView.reply,null);
    assert.equal(f.calls.filter(p=>p==='/v1/responses').length,1);
  }finally{release();await f.mf.dispose();}
});
test('silent card participation uses server autonomy after ten seconds, without a host',async()=>{
  const f=await fixture();try{
    const a=await f.join();const socket=await f.mf.dispatchFetch('https://test.example/api/world-room/room/events',{headers:{Upgrade:'websocket',Origin:'https://test.example',Cookie:a.cookie}});socket.webSocket.accept();await f.request('/api/world-room/room/presence',{active:true},a.cookie,a.headers);
    await f.request('/api/world-room/room/card',{eventId:'silent',cardId:'crab',epoch:0},a.cookie);
    assert.equal(f.calls.includes('/v1/responses'),false);
    await new Promise(r=>setTimeout(r,10100));await f.request('/api/world-room/room/presence',{active:true},a.cookie,a.headers);
    for(let i=0;i<100&&!f.calls.includes('/v1/responses');i++)await new Promise(r=>setTimeout(r,20));
    assert.equal(f.calls.filter(p=>p==='/v1/responses').length,1,JSON.stringify((await f.snapshot(a)).outcomes));
  }finally{await f.mf.dispose();}
});
test('cache-only background and prop misses do not call a provider or undo room physics',async()=>{
  const action={targetId:'',concept:'crab',sourceCardIds:['crab'],effects:[],count:1};
  const f=await fixture({intent:{actions:[{...action,type:'prop'},{...action,type:'background',concept:'underwater'},{...action,type:'physics',concept:'zero'}]}});
  try{
    const a=await f.join();await f.request('/api/world-room/room/card',{eventId:'crab',cardId:'crab',epoch:0},a.cookie);
    assert.equal((await f.request('/api/world-room/room/generation',{enabled:true,generation:0},a.cookie,a.headers)).status,200);
    await f.request('/api/world-room/room/conversation',{id:'visual-turn',kind:'text',text:'カニを浮かべて',epoch:0},a.cookie,a.headers);
    let next;for(let i=0;i<100;i++){next=await f.snapshot(a);if(next.elements.length===2&&next.elements.every(e=>e.status==='failed'))break;await new Promise(r=>setTimeout(r,20));}
    assert.equal(next.physics.mode,'zero');assert.equal(next.elements.length,2);
    assert.ok(next.elements.every(e=>e.status==='failed'&&e.error==='cache_miss'),JSON.stringify(next.elements));
    assert.ok(f.calls.every(p=>['/siteverify','/turnstile/v0/siteverify','/v1/responses','/v1/tts/synthesize'].includes(p)),JSON.stringify(f.calls));
  }finally{await f.mf.dispose();}
});
