import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const dir='node_modules/.tmp/visual';await mkdir(dir,{recursive:true});
const result=await build({stdin:{contents:'export * from "./worker/ledger"; export * from "./src/visual/types"; export * from "./src/visual/decision"; export * from "./src/visual/notice"; export * from "./src/visual/session"; export * from "./worker/visual"; export * from "./worker/visualMedia"; export * from "./src/visual/modeError";',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
await writeFile(dir+'/test.mjs',result.outputFiles[0].text);
const {Ledger,initialState,readVisualIntent,cacheDecision,assetDescriptionKey,permitsVideo,VisualSession,sharedVisual,inspectVisualPng}=await import('../'+dir+'/test.mjs');
const intent={type:'prop',action:'add',concept:'chicken',modifiers:[],targetId:'target',motion:'',motionEvidence:'',sharing:'general',regenerate:false};
function setup(){const state=initialState();state.limits={...state.limits,visitorDay:100,visitorMonth:100,dayBudget:10000000000,monthBudget:10000000000};const l=new Ledger(state,1000);l.start('v','ip','s');return{state,l};}
const asset={id:'asset',url:'asset',kind:'image',composite:'alpha',type:'prop',concept:'chicken',createdAt:1000,expiresAt:30*86400000,scope:'shared'};
test('OFF and stale permission prohibit reservations; state survives restart without replenishing spend',()=>{
 const {state,l}=setup();assert.deepEqual(l.visualPermission('v','s'),{enabled:false,generation:0});
 assert.throws(()=>l.visualStart('v','s',0,'a','key','target',30000),/visual_disabled/);
 const on=l.visualMode('v','s',true,0);l.visualStart('v','s',on.generation,'a','key','target',30000);l.visualReserve('v','s',on.generation,'a','image',10000);
 l.visualMode('v','s',false,on.generation);
 assert.throws(()=>l.visualReserve('v','s',on.generation,'a','mask',50000),/visual_disabled/);
 assert.throws(()=>l.visualPublish('v','s',on.generation,'a',asset),/visual_disabled/);
 const restored=new Ledger(JSON.parse(JSON.stringify(state)),2000);assert.equal(restored.report().manifestation.reservedUsd,.01);assert.equal(restored.visualPermission('v','s').enabled,false);
 assert.throws(()=>restored.visualMode('v','s',true,on.generation),/stale_permission/);
});
test('per-step reservations keep existing cumulative and session caps',()=>{
 const {l,state}=setup();l.visualMode('v','s',true,0);l.visualStart('v','s',1,'a','key','target',30000);
 l.visualReserve('v','s',1,'a','image',10000);assert.throws(()=>l.visualReserve('v','s',1,'a','image',10000),/duplicate_event/);
 state.manifestation.reservedMicrousd=4999000;assert.throws(()=>l.visualReserve('v','s',1,'a','mask',50000),/manifestation_budget/);
 state.manifestation.reservedMicrousd=10000;state.manifestation.requests.s=20;assert.throws(()=>l.visualReserve('v','s',1,'a','mask',50000),/manifestation_limit/);
 state.manifestation.requests.s=1;state.limits.dayBudget=1;assert.throws(()=>l.visualReserve('v','s',1,'a','mask',50000),/daily_budget/);
});
test('same cache claim is shared, target replacement cancels only that target, private cache stays private',()=>{
 const {l}=setup();l.visualMode('v','s',true,0);l.visualStart('v','s',1,'a','one','first',30000);
 assert.deepEqual(l.visualStart('v','s',1,'b','one','second',30000),{owner:false});
 l.visualStart('v','s',1,'c','two','second',30000);l.visualPublish('v','s',1,'a',asset);
 l.visualStart('v','s',1,'d','three','first',30000);assert.throws(()=>l.visualReserve('v','s',1,'a','mask',50000),/job_expired/);
 l.visualReserve('v','s',1,'c','image',10000);
 assert.equal(l.visualLookup('v','s',1,'one').id,'asset');
 l.visualPublish('v','s',1,'c',{...asset,scope:'s'});l.start('v2','ip2','s2');l.visualMode('v2','s2',true,0);assert.equal(l.visualLookup('v2','s2',1,'two'),null);
});
test('cache periods, shape keys, explicit video evidence, and conservative sharing',()=>{
 assert.equal(cacheDecision(asset,1001,true),'reuse');assert.equal(cacheDecision(asset,86400000+1000,false),'reuse');assert.equal(cacheDecision(asset,86400000+1000,true),'refresh');assert.equal(cacheDecision(asset,7*86400000+1000,false),'refresh');
 assert.equal(assetDescriptionKey(intent,false),assetDescriptionKey({...intent,modifiers:['grow','sparkle']},false));
 assert.notEqual(assetDescriptionKey(intent,false),assetDescriptionKey({...intent,modifiers:['transparent']},false));
 assert.equal(permitsVideo({...intent,motion:'walk',motionEvidence:'歩いて'},'鶏に歩いてほしい'),true);assert.equal(permitsVideo({...intent,motion:'walk',motionEvidence:'歩いて'},'鶏いる？'),false);
 assert.equal(sharedVisual(intent),true);assert.equal(sharedVisual({...intent,concept:'Sayaka designer'}),false);assert.equal(sharedVisual({...intent,sharing:'uncertain'}),false);
 assert.equal(readVisualIntent({...intent,modifiers:[null]}),null);
});
const flush=()=>new Promise(r=>setImmediate(r));
test('3, 8, 15 second results still display; OFF and superseding results do not; no timers generate',async()=>{
 let now=0;const pending=[];let notices=0;
 const session=new VisualSession({now:()=>now,prepare:async()=>{},notice:()=>notices++,generate:(job,signal,accept)=>new Promise(resolve=>pending.push({job,signal,accept,resolve}))});
 session.permission(true,1);
 for(const [i,seconds] of [3,8,15].entries()){session.dispatch('e'+i,{...intent,targetId:'t'+i},'ticket',1);now+=seconds*1000;await pending[i].accept(asset);pending[i].resolve();await flush();session.visible('t'+i);session.visible('t'+i);}
 assert.equal(notices,3);assert.equal(session.getSnapshot().objects.length,3);
 session.dispatch('cancelled',{...intent,targetId:'late'},'ticket',1);session.permission(false,2);await pending[3].accept(asset);pending[3].resolve();await flush();assert.equal(session.getSnapshot().objects.some(o=>o.id==='late'),false);
 now+=50000;session.tick();assert.equal(session.getSnapshot().objects.length,0);assert.equal(pending.length,4);
});
test('concurrency stays two with newest one waiting; background persists; upper bounds cancel',async()=>{
 let now=0;const calls=[];const session=new VisualSession({now:()=>now,prepare:async()=>{},generate:(job,signal,accept)=>new Promise(resolve=>calls.push({job,signal,accept,resolve}))});
 session.permission(true,1);for(let i=0;i<5;i++)session.dispatch('e'+i,{...intent,targetId:'t'+i},'ticket',1);
 assert.equal(calls.length,2);assert.equal(session.getSnapshot().pending.length,3);assert.equal(session.getSnapshot().pending.at(-1).id,'e4');
 now=30001;session.tick();assert.equal(session.getSnapshot().pending.length,0);assert.equal(calls[0].signal.aborted,true);
 calls.forEach(c=>c.resolve());await flush();session.dispatch('bg',{...intent,type:'background',targetId:'background'},'ticket',1);await calls.at(-1).accept({...asset,type:'background',composite:'opaque'});calls.at(-1).resolve();await flush();session.visible('background');now+=90000;session.tick();assert.ok(session.getSnapshot().background);
});
test('PNG inspection accepts bundled alpha assets and rejects nontransparent source',async()=>{
 await inspectVisualPng(new Uint8Array(await readFile('public/manifestation/chicken-1.png')),true);
 await assert.rejects(inspectVisualPng(new Uint8Array(await readFile('public/manifestation/chicken-source.png')),true));
});

test('signed routes reject OFF, stale permits and another session; stock uses no paid request',async()=>{
 const {l}=setup();const calls=[];
 const bridge=async(op,b)=>{calls.push(op);switch(op){case 'visualPermission':return l.visualPermission(b.visitor,b.id);case 'visualMode':return l.visualMode(b.visitor,b.id,b.enabled,b.generation);case 'visualLookup':return l.visualLookup(b.visitor,b.id,b.generation,b.key);case 'visualCancel':return l.visualCancel(b.visitor,b.id,b.generation,b.target,b.token);default:throw new Error('Unexpected '+op);}};
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',COOKIE_SECRET:'test-secret-'.repeat(4),GENERATION_ENABLED:'true'};
 const response=await visualTicket({visualIntent:intent},env,'v','s',1,false);
 const request=()=>new Request('https://example/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:response.visualTicket})});
 await assert.rejects(visualRoute(request(),env,'v','s',bridge),/visual_disabled/);
 l.visualMode('v','s',true,0);const good=await visualRoute(request(),env,'v','s',bridge);const body=await good.json();assert.equal(body.type,'asset');assert.match(body.asset.url,/chicken-1.png$/);assert.equal(calls.includes('visualReserve'),false);
 await assert.rejects(visualRoute(request(),env,'v','other',bridge),/invalid_ticket/);
 l.visualMode('v','s',false,1);l.visualMode('v','s',true,2);await assert.rejects(visualRoute(request(),env,'v','s',bridge),/visual_disabled/);
});
test('each background intent reacts once, late refinement does not repeat the same event',async()=>{
 let now=0;const pending=[];const notices=[];const s=new VisualSession({now:()=>now,prepare:async()=>{},notice:id=>notices.push(id),generate:(j,signal,accept)=>new Promise(resolve=>pending.push({j,accept,resolve}))});s.permission(true,1);
 for(let i=0;i<2;i++){s.dispatch('bg'+i,{...intent,type:'background',targetId:'background'},'ticket',1);await pending[i].accept({...asset,id:'bg'+i,type:'background'});s.visible('background');await pending[i].accept({...asset,id:'refined'+i,type:'background'});s.visible('background');pending[i].resolve();await flush();now++;}
 assert.deepEqual(notices,['bg0','bg1']);
});
test('cancel targets its old job, not a newer job for the same object',()=>{
 const {l}=setup();l.visualMode('v','s',true,0);l.visualStart('v','s',1,'old','key1','target',30000);l.visualStart('v','s',1,'new','key2','target',30000);l.visualCancel('v','s',1,'target','old');l.visualReserve('v','s',1,'new','image',10000);assert.throws(()=>l.visualReserve('v','s',1,'old','image',10000),/job_expired/);
});


test('real route pipeline reserves image and removal, inspects PNG, stores privately and reuses shared cache',async()=>{
 const {l}=setup();l.visualMode('v','s',true,0);const ops=[];
 const bridge=async(op,b)=>{ops.push(op);switch(op){case 'visualPermission':return l.visualPermission(b.visitor,b.id);case 'visualLookup':return l.visualLookup(b.visitor,b.id,b.generation,b.key);case 'visualStart':return l.visualStart(b.visitor,b.id,b.generation,b.token,b.key,b.target,b.duration);case 'visualReserve':return l.visualReserve(b.visitor,b.id,b.generation,b.token,b.step,b.cost);case 'visualPublish':return l.visualPublish(b.visitor,b.id,b.generation,b.token,b.asset);case 'visualFinish':return l.visualFinish(b.visitor,b.id,b.token,b.code,b.timings);default:throw new Error('Unexpected '+op);}};
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');const png=await readFile('public/manifestation/chicken-1.png');let puts=0,submits=0;
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',COOKIE_SECRET:'test-secret-'.repeat(4),GENERATION_ENABLED:'true',FAL_KEY:'dummy',VISUAL_ASSETS:{put:async()=>puts++}};
 const original=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{const u=new URL(url);if(u.hostname==='api.fal.ai')return Response.json({prices:[{endpoint_id:u.searchParams.get('endpoint_id'),unit_price:.0001,unit:u.searchParams.get('endpoint_id').includes('birefnet')?'compute seconds':'megapixels',currency:'USD'}]});if(u.hostname==='fal.media')return new Response(png,{headers:{'Content-Type':'image/png'}});if(init?.method==='POST'){submits++;return Response.json({status_url:'https://queue.fal.run/status',response_url:'https://queue.fal.run/result'});}if(u.pathname==='/status')return Response.json({status:'COMPLETED'});return Response.json({images:[{url:'https://fal.media/result.png'}],image:{url:'https://fal.media/result.png'}});};
 try{for(let i=0;i<2;i++){const signed=await visualTicket({visualIntent:{...intent,concept:'crab'}},env,'v','s',1,false);const r=await visualRoute(new Request('https://example/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:signed.visualTicket})}),env,'v','s',bridge);const t=await r.text();assert.match(t,/"type":"asset"/);assert.doesNotMatch(t,/"type":"failed"/);assert.doesNotMatch(t,/fal.media/);}
 assert.equal(submits,2);assert.equal(puts,1);assert.equal(l.report().manifestation.reservedUsd,.06);assert.equal(ops.filter(o=>o==='visualReserve').length,2);
 }finally{globalThis.fetch=original;}
});

test('effect changes require server acceptance and keep the displayed target ID',async()=>{
 const {visualTicket}=await import('../'+dir+'/test.mjs');const effect={...intent,type:'effect',concept:'sparkle',targetId:'existing'};
 const signed=await visualTicket({visualIntent:effect},{COOKIE_SECRET:'test-secret-'.repeat(4)},'v','s',1,false);assert.equal(signed.visualIntent.targetId,'existing');
 let rejectEffect=true;const session=new VisualSession({now:()=>0,prepare:async()=>{},generate:async(job,signal,accept)=>{if(job.intent.type==='effect'){if(rejectEffect)throw new Error('visual_disabled');return;}await accept(asset);}});session.permission(true,1);session.dispatch('object',{...intent,targetId:'existing'},'ticket',1);await flush();session.visible('existing');session.dispatch('blocked',effect,'ticket',1);await flush();assert.deepEqual(session.getSnapshot().objects[0].effects,[]);rejectEffect=false;session.dispatch('allowed',effect,'ticket',1);await flush();assert.deepEqual(session.getSnapshot().objects[0].effects,['sparkle']);
});

test('mode failures expose only safe codes and distinguish connection, session, and unavailable feature',async()=>{
 const {VisualModeError,visualModeErrorMessage}=await import('../'+dir+'/test.mjs');
 assert.match(visualModeErrorMessage(new VisualModeError(503,'network_error')),/接続できません/);
 assert.match(visualModeErrorMessage(new VisualModeError(401,'session_expired')),/有効期限/);
 assert.match(visualModeErrorMessage(new VisualModeError(404,'not_found')),/利用できません/);
 assert.equal(new VisualModeError(500,'private response data').code,'unknown');
});


test('explicit current object requests constrain decisions without forcing negation or ambiguous targets', async()=>{
 const {explicitVisualSubject,visualDecisionSchema,validVisualDecision}=await import('../'+dir+'/test.mjs');
 for(const text of ['ボールを出して','肉を出してください','プリンを作って！','紫色の飛行船を召喚して'])assert.ok(explicitVisualSubject(text));
 for(const text of ['ボールを出さないで','昨日ボールを出してと言った','「ボールを出して」って言った','もしボールを出してくれたら','ボールが好き','それを出して','何かを出して'])assert.equal(explicitVisualSubject(text),null,text);
 assert.deepEqual(visualDecisionSchema(true).properties.type.enum,['prop']);
 assert.equal(validVisualDecision({...intent,type:'none'},true),null);
 assert.ok(validVisualDecision({...intent,type:'none'},false));
});

test('notifications expire, keep newest request priority, and ignore old permission generations',async()=>{
 let now=0;const s=new VisualSession({now:()=>now,prepare:async()=>{},generate:async()=>{}});s.permission(true,1);
 s.status('a','deciding',1);assert.match(s.getSnapshot().notification.message,/確認/);
 s.status('b','queued',1);s.status('a','provider_rejected',1);assert.equal(s.getSnapshot().notification.id,'b');
 s.status('b','provider_rejected',1);assert.match(s.getSnapshot().notification.message,/受け付け/);
 now=6001;s.tick();assert.equal(s.getSnapshot().notification,undefined);
 s.permission(false,2);s.status('b','generating',1);assert.equal(s.getSnapshot().notification,undefined);
});

test('prepared candidates do not replace visible state until first display; failed placement keeps old object',async()=>{
 const s=new VisualSession({now:()=>100,prepare:async()=>{},generate:async(j,signal,accept)=>accept({...asset,id:j.id})});s.permission(true,1);
 s.dispatch('old',intent,'t',1);await flush();assert.equal(s.getSnapshot().objects.length,0);s.visible('target');
 s.dispatch('new',intent,'t2',1);await flush();assert.equal(s.getSnapshot().objects[0].asset.id,'old');
 s.placementFailed('target');assert.equal(s.getSnapshot().objects[0].asset.id,'old');assert.match(s.getSnapshot().notification.message,/空き領域/);
});

test('safe failure messages never echo provider text and distinguish limits, inspection, and timeouts',async()=>{
 const {visualFailureMessage:f}=await import('../'+dir+'/test.mjs');
 assert.match(f('manifestation_budget'),/上限/);assert.match(f('background_not_adopted'),/休止/);
 assert.match(f('alpha_quality'),/検査/);assert.match(f('timeout'),/待機時間/);
 assert.doesNotMatch(f('https://secret.example/?key=private'),/secret|private/);
});
