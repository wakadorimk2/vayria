import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
const dir='node_modules/.tmp/visual';await mkdir(dir,{recursive:true});
const result=await build({stdin:{contents:'export * from "./src/world/placementObstacles"; export * from "./src/visual/placement"; export * from "./src/manifestation/media"; export * from "./src/manifestation/videoPlayback"; export * from "./src/visual/diagnostics"; export * from "./worker/ledger"; export * from "./src/visual/types"; export * from "./src/visual/decision"; export * from "./src/visual/notice"; export * from "./src/visual/session"; export * from "./worker/visual"; export * from "./worker/visualMedia"; export * from "./src/visual/modeError";',resolveDir:process.cwd(),loader:'ts'},bundle:true,write:false,format:'esm',platform:'node'});
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
 assert.equal(cacheDecision(asset,1001,true),'refresh');assert.equal(cacheDecision(asset,86400000+1000,false),'reuse');assert.equal(cacheDecision(asset,86400000+1000,true),'refresh');assert.equal(cacheDecision(asset,7*86400000+1000,false),'reuse');
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
 const bridge=async(op,b)=>{calls.push(op);switch(op){case 'visualLookupAny':return l.visualLookupAny(b.visitor,b.id,b.generation,b.keys);case 'visualAlias':return l.visualAlias(b.visitor,b.id,b.generation,b.key,b.fromKey);case 'visualClaim':return l.visualClaim(b.visitor,b.id,b.generation,b.token,b.key);case 'visualClaimActive':return l.visualClaimActive(b.visitor,b.id,b.generation,b.key,b.token);case 'visualReplay':return l.visualReplay(b.visitor,b.id,b.generation,b.key);case 'visualPermission':return l.visualPermission(b.visitor,b.id);case 'visualMode':return l.visualMode(b.visitor,b.id,b.enabled,b.generation);case 'visualLookup':return l.visualLookup(b.visitor,b.id,b.generation,b.key);case 'visualCancel':return l.visualCancel(b.visitor,b.id,b.generation,b.target,b.token);default:throw new Error('Unexpected '+op);}};
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
 const bridge=async(op,b)=>{ops.push(op);switch(op){case 'visualLookupAny':return l.visualLookupAny(b.visitor,b.id,b.generation,b.keys);case 'visualAlias':return l.visualAlias(b.visitor,b.id,b.generation,b.key,b.fromKey);case 'visualClaim':return l.visualClaim(b.visitor,b.id,b.generation,b.token,b.key);case 'visualClaimActive':return l.visualClaimActive(b.visitor,b.id,b.generation,b.key,b.token);case 'visualReplay':return l.visualReplay(b.visitor,b.id,b.generation,b.key);case 'visualPermission':return l.visualPermission(b.visitor,b.id);case 'visualLookup':return l.visualLookup(b.visitor,b.id,b.generation,b.key);case 'visualStart':return l.visualStart(b.visitor,b.id,b.generation,b.token,b.key,b.target,b.duration);case 'visualReserve':return l.visualReserve(b.visitor,b.id,b.generation,b.token,b.step,b.cost);case 'visualPublish':return l.visualPublish(b.visitor,b.id,b.generation,b.token,b.asset,b.key);case 'visualFinish':return l.visualFinish(b.visitor,b.id,b.token,b.code,b.timings);default:throw new Error('Unexpected '+op);}};
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
 s.placementFailed('target');assert.equal(s.getSnapshot().objects[0].asset.id,'old');assert.match(s.getSnapshot().notification.message,/UIを閉じる/);
});

test('safe failure messages never echo provider text and distinguish limits, inspection, and timeouts',async()=>{
 const {visualFailureMessage:f}=await import('../'+dir+'/test.mjs');
 assert.match(f('manifestation_budget'),/上限/);assert.match(f('background_not_adopted'),/休止/);
 assert.match(f('alpha_quality'),/検査/);assert.match(f('timeout'),/待機時間/);
 assert.doesNotMatch(f('https://secret.example/?key=private'),/secret|private/);
});

test('explicit subject cannot broaden pudding into a generic dessert',async()=>{
 const {visualDecisionSchema,validVisualDecision}=await import('../'+dir+'/test.mjs');
 assert.deepEqual(visualDecisionSchema(true,'プリン').properties.concept.enum,['pudding']);
 assert.equal(validVisualDecision({...intent,concept:'dessert'},true,'プリン'),null);
 assert.ok(validVisualDecision({...intent,concept:'pudding'},true,'プリン'));
});

test('unknown requested objects still use the same LLM translation and never send Japanese lettering as an object',async()=>{
 const {validVisualDecision,visualDecisionSchema}=await import('../'+dir+'/test.mjs');
 assert.ok(validVisualDecision({...intent,concept:'purple airship'},true,'紫色の飛行船'));
 assert.equal(validVisualDecision({...intent,concept:'プリン'},true,'プリン'),null);
 assert.equal(visualDecisionSchema(true,'紫色の飛行船').properties.concept.enum,undefined);
});


test('video request supports robot motion but rejects negation, quotes, history and transform effects',()=>{
 const moving={...intent,concept:'robot',motion:'dance',motionEvidence:'踊って'};
 assert.equal(permitsVideo(moving,'ロボットに踊ってほしい'),true);
 for(const input of ['踊ってと言ったのは昨日','「踊って」と言った','踊ってほしくないでしょ'])assert.equal(permitsVideo(moving,input),false,input);
 assert.equal(permitsVideo({...moving,motion:'float'},'ロボットに踊ってほしい'),false);
});
test('video disabled refuses before lookup or paid reservation',async()=>{
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');let calls=0;
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',COOKIE_SECRET:'test-secret-'.repeat(4)};
 const signed=await visualTicket({visualIntent:{...intent,motion:'walk',motionEvidence:'歩いて'}},env,'v','s',1,true);
 const result=await visualRoute(new Request('https://test/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:signed.visualTicket})}),env,'v','s',async op=>{calls++;assert.equal(op,'visualPermission');return {enabled:true,generation:1}});
 assert.deepEqual(await result.json(),{type:'failed',code:'video_disabled'});assert.equal(calls,1);
});
test('Worker creates opaque video source without losing original dimensions',async()=>{
 const {videoSourcePng}=await import('../'+dir+'/test.mjs');const input=await readFile('public/manifestation/chicken-1.png');
 const result=await videoSourcePng(new Uint8Array(input));const original=await inspectVisualPng(new Uint8Array(input),true);
 assert.deepEqual(await inspectVisualPng(result.bytes,false),{width:original.width,height:original.height});assert.ok(['green','blue'].includes(result.keyColor));
});
test('image to video replacement waits for visibility and failed playback preserves image',async()=>{
 let accept,finish;let clock=100;const notices=[];const s=new VisualSession({now:()=>clock,prepare:async()=>{},notice:(id)=>notices.push(id),generate:async(j,signal,a)=>{accept=a;await new Promise(r=>finish=r);}});s.permission(true,1);s.dispatch('motion',intent,'t',1);
 await accept({...asset,id:'base',width:400,height:800});s.visible('target','base');clock=500;await accept({...asset,id:'video',kind:'video'});assert.equal(s.getSnapshot().objects[0].asset.id,'base');
 s.placementFailed('target','video','video_decode_failed');assert.equal(s.getSnapshot().objects[0].asset.id,'base');
 await accept({...asset,id:'video2',kind:'video'});s.visible('target','video2');s.visible('target','video2');assert.equal(s.getSnapshot().objects[0].at,100);assert.equal(s.getSnapshot().objects[0].layoutAspect,.5);assert.deepEqual(notices,['motion','motion:video']);finish();await flush();
});


test('robot video emits its own image first and reserves each provider request once',async()=>{
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');const {l}=setup();l.visualMode('v','s',true,0);
 const png=await readFile('public/manifestation/chicken-1.png'),store=new Map();let videoInput;
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',COOKIE_SECRET:'test-secret-'.repeat(4),GENERATION_ENABLED:'true',VISUAL_VIDEO_ENABLED:'true',FAL_KEY:'dummy',VISUAL_ASSETS:{put:async(id,bytes)=>store.set(id,bytes),get:async id=>store.has(id)?new Response(store.get(id)):null}};
 const bridge=async(op,b)=>{switch(op){case 'visualLookupAny':return l.visualLookupAny(b.visitor,b.id,b.generation,b.keys);case 'visualAlias':return l.visualAlias(b.visitor,b.id,b.generation,b.key,b.fromKey);case 'visualClaim':return l.visualClaim(b.visitor,b.id,b.generation,b.token,b.key);case 'visualClaimActive':return l.visualClaimActive(b.visitor,b.id,b.generation,b.key,b.token);case 'visualReplay':return l.visualReplay(b.visitor,b.id,b.generation,b.key);case 'visualPermission':return l.visualPermission(b.visitor,b.id);case 'visualLookup':return l.visualLookup(b.visitor,b.id,b.generation,b.key);case 'visualStart':return l.visualStart(b.visitor,b.id,b.generation,b.token,b.key,b.target,b.duration);case 'visualReserve':return l.visualReserve(b.visitor,b.id,b.generation,b.token,b.step,b.cost);case 'visualPublish':return l.visualPublish(b.visitor,b.id,b.generation,b.token,b.asset,b.key);case 'visualFinish':return l.visualFinish(b.visitor,b.id,b.token,b.code,b.timings);default:throw new Error(op)}};
 const previous=globalThis.fetch;globalThis.fetch=async(url,init)=>{
 const u=new URL(url);
 if(u.hostname==='api.fal.ai')return Response.json({prices:[{endpoint_id:u.searchParams.get('endpoint_id'),unit_price:.0001,unit:u.searchParams.get('endpoint_id').includes('video')?'seconds':u.searchParams.get('endpoint_id').includes('birefnet')?'compute seconds':'megapixels',currency:'USD'}]});
 if(u.hostname==='fal.media')return new Response(u.pathname.endsWith('mp4')?'mock-video':png,{headers:{'Content-Type':u.pathname.endsWith('mp4')?'video/mp4':'image/png'}});
 if(init?.method==='POST'){const video=u.pathname.includes('video');if(video)videoInput=JSON.parse(init.body);return Response.json({status_url:'https://queue.fal.run/status',response_url:'https://queue.fal.run/'+(video?'video':'image')});}
 if(u.pathname==='/status')return Response.json({status:'COMPLETED'});
 return Response.json({video:{url:'https://fal.media/robot.mp4'},images:[{url:'https://fal.media/robot.png'}],image:{url:'https://fal.media/robot.png'}});
 };
 try{
 const signed=await visualTicket({visualIntent:{...intent,concept:'robot',motion:'dance',motionEvidence:'踊って'}},env,'v','s',1,true);
 const response=await visualRoute(new Request('https://test/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:signed.visualTicket})}),env,'v','s',bridge);
 const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.asset?.kind),['image','video'],JSON.stringify(events));
 assert.ok(events.every(e=>e.asset.concept==='robot'));assert.match(videoInput.prompt,/robot/);assert.doesNotMatch(videoInput.prompt,/chicken/);assert.ok(events[1].asset.source);assert.equal(l.report().manifestation.reservedUsd,.185);
 }finally{globalThis.fetch=previous}
});


test('explicit articulated action is required in the same response schema',async()=>{
 const {explicitMotionSubject,visualDecisionSchema,validVisualDecision}=await import('../'+dir+'/test.mjs');
 assert.equal(explicitMotionSubject('鶏を歩かせて。'),'鶏');assert.equal(explicitMotionSubject('踊るロボットを出して'),'ロボット');
 assert.equal(explicitMotionSubject('鶏を歩かせないで'),null);
 const schema=visualDecisionSchema(true,'鶏','鶏を歩かせて。');assert.equal(schema.properties.motion.minLength,1);
 assert.equal(validVisualDecision({...intent,motion:'',motionEvidence:''},true,'鶏','鶏を歩かせて。'),null);
 assert.ok(validVisualDecision({...intent,motion:'walk',motionEvidence:'鶏を歩かせて。'},true,'鶏','鶏を歩かせて。'));
});

const {waitVideoEvent,playVideo,VideoFrameProgress,readVisualDiagnostic}=await import('../'+dir+'/test.mjs');
test('video media stages distinguish loading, seek, play refusal and abort',async()=>{
 const video=new EventTarget();video.pause=()=>{};
 await assert.rejects(waitVideoEvent(video,'loadeddata',new AbortController().signal,5,'video_loading_timeout'),/video_loading_timeout/);
 await assert.rejects(waitVideoEvent(video,'seeked',new AbortController().signal,5,'video_seek_timeout'),/video_seek_timeout/);
 const wait=waitVideoEvent(video,'loadeddata',new AbortController().signal,50,'timeout');video.dispatchEvent(new Event('error'));await assert.rejects(wait,/video_load_failed/);
 video.play=()=>Promise.reject(new DOMException('blocked','NotAllowedError'));await assert.rejects(playVideo(video,new AbortController().signal),/video_play_rejected/);
 video.play=()=>new Promise(()=>{});const controller=new AbortController();const pending=playVideo(video,controller.signal);controller.abort();await assert.rejects(pending,/aborted/);
 const frames=new VideoFrameProgress();assert.equal(frames.advancing(0),false);assert.equal(frames.advancing(0),false);assert.equal(frames.advancing(.1),true);assert.equal(frames.advancing(.1),false);
});
test('diagnostics retain only safe bounded stages and reject stale permission',()=>{
 const {l}=setup();l.visualMode('v','s',true,0);
 const record={build:'index-test.js',stage:'video_play_rejected',milliseconds:100};
 assert.equal(readVisualDiagnostic({...record,url:'secret'}),null);assert.equal(readVisualDiagnostic({...record,stage:'arbitrary text'}),null);
 l.visualDiagnostic('v','s',1,'event',[record]);l.visualDiagnostic('v','s',1,'event',[record]);assert.equal(l.report().visualDiagnostics.length,1);
 l.visualMode('v','s',false,1);assert.throws(()=>l.visualDiagnostic('v','s',1,'event',[record]),/visual_disabled/);
 assert.equal(l.report().manifestation.reservedUsd,0);
});
test('exact moving chicken request permits video',()=>{
 assert.equal(permitsVideo({...intent,motion:'move',motionEvidence:'動く'},'動く鶏を出して'),true);
});

test('cache-only video probe never reserves or generates on a miss',async()=>{
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',VISUAL_VIDEO_ENABLED:'true',COOKIE_SECRET:'test-secret-'.repeat(4)};
 const signed=await visualTicket({visualIntent:{...intent,motion:'move',motionEvidence:'動く'}},env,'v','s',1,true,'event');
 const calls=[];const response=await visualRoute(new Request('https://test/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:signed.visualTicket,cacheOnly:true})}),env,'v','s',async op=>{calls.push(op);if(op==='visualPermission')return {enabled:true,generation:1};if(op==='visualLookup'||op==='visualLookupAny')return null;throw new Error('paid path');});
 assert.equal((await response.json()).code,'cache_miss');assert.ok(calls.every(op=>['visualPermission','visualLookup','visualLookupAny','visualFinish'].includes(op)));
});

test('metadata-only preload advances by play before loadeddata',async()=>{
 const {prepareObject,preparedVideos,releasePrepared}=await import('../'+dir+'/test.mjs');
 const previous=globalThis.document;const video=Object.assign(new EventTarget(),{readyState:1,videoWidth:128,videoHeight:128,duration:5,currentTime:0,pause(){},removeAttribute(){},load(){},async play(){this.readyState=2;}});
 const data=new Uint8ClampedArray(128*128*4);for(let p=0;p<128*128;p++){data[p*4+1]=255;data[p*4+3]=255;if(p%128>40&&p%128<85&&p/128>40&&p/128<85)data[p*4]=data[p*4+2]=255;}
 globalThis.document={createElement:tag=>tag==='video'?video:{getContext:()=>({drawImage(){},getImageData:()=>({data:data.slice()})})}};
 const url='/staging/api/visual/media/s-abcdef?ticket=abc';try{await prepareObject({url,kind:'video',timings:{}},new AbortController().signal);assert.equal(preparedVideos.get(url),video);releasePrepared(url);}finally{globalThis.document=previous;}
});
test('ten dollar configuration preserves existing spend and the default five dollar ceiling',()=>{
 const {l,state}=setup();state.manifestation={reservedMicrousd:3070000,requests:{},events:{},jobs:{},metrics:[]};
 l.configure({manifestationMicrousd:10000000});assert.equal(l.report().manifestation.reservedUsd,3.07);assert.equal(l.report().manifestation.limitUsd,10);
 const restored=new Ledger(JSON.parse(JSON.stringify(state)),2000);assert.equal(restored.report().manifestation.limitUsd,10);
 assert.equal(setup().l.report().manifestation.limitUsd,5);
});
test('dance and crustacean subjects are distinct and explicit',async()=>{
 const {explicitMotionSubject,visualDecisionSchema,validVisualDecision}=await import('../'+dir+'/test.mjs');
 for(const [input,subject,concept] of [['ダンスするみかんを出して','みかん','mandarin orange'],['歩くエビを出して','エビ','shrimp'],['歩くカニを出して','カニ','crab']]){
 assert.equal(explicitMotionSubject(input),subject);assert.deepEqual(visualDecisionSchema(true,subject,input).properties.concept.enum,[concept]);
 assert.equal(validVisualDecision({...intent,concept:'chicken',motion:'walk',motionEvidence:input},true,subject,input),null);}
});
test('expired relay and private replay cannot cross sessions',()=>{
 const {l,state}=setup();l.visualMode('v','s',true,0);l.visualMediaRegister('v','s',1,'asset','https://fal.media/video.mp4');assert.ok(l.visualMediaLookup('v','s','asset'));
 assert.throws(()=>l.visualMediaRegister('v','s',1,'other','https://attacker.example/a'),/invalid_media/);
 state.visualMedia.asset.expires=999;assert.equal(l.visualMediaLookup('v','s','asset'),null);
});
test('video is delivered before asynchronous R2 persistence',async()=>{
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');const {l}=setup();l.visualMode('v','s',true,0);
 const png=await readFile('public/manifestation/chicken-1.png'),store=new Map();let videoInput;
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',COOKIE_SECRET:'test-secret-'.repeat(4),GENERATION_ENABLED:'true',VISUAL_VIDEO_ENABLED:'true',FAL_KEY:'dummy',VISUAL_ASSETS:{put:async(id,bytes)=>store.set(id,bytes),get:async id=>store.has(id)?new Response(store.get(id)):null}};
 const bridge=async(op,b)=>{switch(op){case 'visualLookupAny':return l.visualLookupAny(b.visitor,b.id,b.generation,b.keys);case 'visualAlias':return l.visualAlias(b.visitor,b.id,b.generation,b.key,b.fromKey);case 'visualClaim':return l.visualClaim(b.visitor,b.id,b.generation,b.token,b.key);case 'visualClaimActive':return l.visualClaimActive(b.visitor,b.id,b.generation,b.key,b.token);case 'visualReplay':return l.visualReplay(b.visitor,b.id,b.generation,b.key);case 'visualPermission':return l.visualPermission(b.visitor,b.id);case 'visualLookup':return l.visualLookup(b.visitor,b.id,b.generation,b.key);case 'visualStart':return l.visualStart(b.visitor,b.id,b.generation,b.token,b.key,b.target,b.duration);case 'visualReserve':return l.visualReserve(b.visitor,b.id,b.generation,b.token,b.step,b.cost);case 'visualPublish':return l.visualPublish(b.visitor,b.id,b.generation,b.token,b.asset,b.key);case 'visualMediaRegister':return l.visualMediaRegister(b.visitor,b.id,b.generation,b.key,b.url);case 'visualMediaSaved':return l.visualMediaSaved(b.visitor,b.id,b.key,b.enabled);case 'visualFinish':return l.visualFinish(b.visitor,b.id,b.token,b.code,b.timings);default:throw new Error(op)}};
 const previous=globalThis.fetch;globalThis.fetch=async(url,init)=>{
 const u=new URL(url);
 if(u.hostname==='api.fal.ai')return Response.json({prices:[{endpoint_id:u.searchParams.get('endpoint_id'),unit_price:.0001,unit:u.searchParams.get('endpoint_id').includes('video')?'seconds':u.searchParams.get('endpoint_id').includes('birefnet')?'compute seconds':'megapixels',currency:'USD'}]});
 if(u.hostname==='fal.media')return new Response(u.pathname.endsWith('mp4')?'mock-video':png,{headers:{'Content-Type':u.pathname.endsWith('mp4')?'video/mp4':'image/png'}});
 if(init?.method==='POST'){const video=u.pathname.includes('video');if(video)videoInput=JSON.parse(init.body);return Response.json({status_url:'https://queue.fal.run/status',response_url:'https://queue.fal.run/'+(video?'video':'image')});}
 if(u.pathname==='/status')return Response.json({status:'COMPLETED'});
 return Response.json({video:{url:'https://fal.media/robot.mp4'},images:[{url:'https://fal.media/robot.png'}],image:{url:'https://fal.media/robot.png'}});
 };
 try{
 const signed=await visualTicket({visualIntent:{...intent,concept:'robot',motion:'dance',motionEvidence:'踊って'}},env,'v','s',1,true);
 const background=[];const response=await visualRoute(new Request('https://test/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:signed.visualTicket})}),env,'v','s',bridge,{waitUntil:p=>background.push(p)});
 const events=(await response.text()).trim().split('\n').map(JSON.parse);assert.deepEqual(events.map(e=>e.asset?.kind),['image','video'],JSON.stringify(events));
 assert.ok(events.every(e=>e.asset.concept==='robot'));assert.match(videoInput.prompt,/robot/);assert.doesNotMatch(videoInput.prompt,/chicken/);assert.ok(events[1].asset.source);assert.equal(l.report().manifestation.reservedUsd,.185);assert.equal(background.length,1);await Promise.all(background);
 }finally{globalThis.fetch=previous}
});

const {placeVisualProp}=await import('../'+dir+'/test.mjs');
test('chest layout uses body center, protects face and controls, caps landscape and giant',()=>{
 const layout={width:400,height:850,body:{x:.1,y:.15,width:.8,height:.8},face:{x:.3,y:.12,width:.4,height:.32},obstacles:[{x:0,y:.9,width:1,height:.1}]};
 const chest=placeVisualProp(layout,true,1,1);assert.ok(chest);assert.equal(chest.width,.55);assert.ok(Math.abs(chest.x+chest.width/2-.5)<.001);assert.ok(chest.y>=.44);assert.ok(chest.y+chest.height<=.9);
 const giant=placeVisualProp(layout,true,1.4,1);assert.ok(giant.width<=.55);
 const shifted=placeVisualProp({...layout,body:{...layout.body,x:.2,width:.6}},true,1,1);assert.ok(Math.abs(shifted.x+shifted.width/2-.5)<.001);
 const landscape=placeVisualProp({...layout,width:850,height:400,body:{x:.4,y:.1,width:.2,height:.8},face:{x:.45,y:.05,width:.1,height:.2}},true,1,1);assert.ok(landscape);assert.ok(landscape.width<=.19);
 for(const aspect of [.5,2]){const p=placeVisualProp(layout,true,1,aspect);assert.ok(p);assert.ok(Math.abs(p.width*400/(p.height*850)-aspect)<.001);}
 const second=placeVisualProp(layout,false,1,1,[chest]);assert.ok(second);assert.ok(second.width<=.275);
 const third=placeVisualProp(layout,false,1,1,[chest,second]);assert.ok(third);
 assert.equal(placeVisualProp({...layout,obstacles:[{x:0,y:0,width:1,height:1}]},true,1,1),null);
});

test('hidden card and chat boxes do not reserve chest space; visible captions remain protected',async()=>{
 const {isPlacementObstacleVisible}=await import('../'+dir+'/test.mjs');
 const previous=globalThis.getComputedStyle;
 globalThis.getComputedStyle=node=>node.style;
 const node=(style={},parentElement=null)=>({style:{display:'block',visibility:'visible',opacity:'1',...style},parentElement});
 try {
  assert.equal(isPlacementObstacleVisible(node()),true);
  for(const style of [{visibility:'hidden'},{display:'none'},{opacity:'0'},{visibility:'collapse'}]){
   assert.equal(isPlacementObstacleVisible(node(style)),false);
   assert.equal(isPlacementObstacleVisible(node({},node(style))),false);
  }
  const layout={width:393,height:665,body:{x:.08,y:.08,width:.84,height:.9},face:{x:.25,y:.1,width:.5,height:.35},obstacles:[{x:.2,y:.45,width:.6,height:.055},{x:.09,y:.88,width:.82,height:.1}]};
  const chest=placeVisualProp(layout,true,1,1);assert.ok(chest);assert.ok(chest.y>=.505);assert.ok(chest.y+chest.height<=.88);
 } finally {globalThis.getComputedStyle=previous;}
});

test('UI hold pauses lifetime, resumes once, and OFF blocks held objects',async()=>{
 let now=100;let accept;const released=[],notices=[];
 const s=new VisualSession({now:()=>now,prepare:async()=>{},release:a=>released.push(a.id),notice:id=>notices.push(id),generate:async(j,signal,a)=>{accept=a;await a(asset);}});
 s.permission(true,1);s.dispatch('held',intent,'t',1);await flush();s.visible('target');
 now=10100;s.hold('target');assert.equal(s.getSnapshot().objects[0].displayedMs,10000);
 now=100100;s.tick();assert.equal(s.getSnapshot().objects.length,1);assert.equal(released.length,0);
 s.permission(false,2);s.visible('target');assert.equal(s.getSnapshot().objects[0].held,true);
 s.permission(true,3);s.visible('target');assert.equal(s.getSnapshot().objects[0].held,false);assert.equal(notices.length,1);
 now+=34999;s.tick();assert.equal(s.getSnapshot().objects.length,1);now+=2;s.tick();assert.equal(s.getSnapshot().objects.length,0);
 assert.ok(accept);
});
test('prepared assets held before first display survive and reset releases them',async()=>{
 let now=0;const released=[];const s=new VisualSession({now:()=>now,prepare:async()=>{},release:a=>released.push(a.id),generate:async(j,signal,a)=>a({...asset,id:j.id})});
 s.permission(true,1);s.dispatch('first',intent,'t',1);await flush();s.hold('target');now=120000;s.tick();assert.equal(s.getSnapshot().ready.length,1);assert.equal(s.getSnapshot().history.length,0);
 s.reset();assert.equal(s.getSnapshot().ready.length,0);assert.ok(released.includes('first'));
});
test('held candidates count toward three and cancel frees a held object',async()=>{
 const s=new VisualSession({now:()=>10,prepare:async()=>{},generate:async(j,signal,a)=>{if(j.intent.action!=='cancel')await a({...asset,id:j.id});}});s.permission(true,1);
 for(let i=0;i<4;i++){s.dispatch('e'+i,{...intent,targetId:'t'+i},'t',1);await flush();s.hold('t'+i);}
 assert.ok(s.getSnapshot().ready.length<=3);assert.ok(s.getSnapshot().ready.some(o=>o.id==='t3'));assert.ok(!s.getSnapshot().ready.some(o=>o.id==='t0'));
 const id=s.getSnapshot().ready[0].id;s.dispatch('cancel',{...intent,targetId:id,action:'cancel'},'t',1);await flush();assert.ok(!s.getSnapshot().ready.some(o=>o.id===id));
});
test('stable placement survives asset replacement and disables unsafe motion',async()=>{
 const {VisualPlacements,visualMotionBounds,fitsVisualRect}=await import('../'+dir+'/test.mjs');
 const l={width:393,height:665,body:{x:.1,y:.1,width:.8,height:.8},face:{x:.25,y:.05,width:.5,height:.4},obstacles:[]};
 const p=new VisualPlacements();const first=p.choose('one',l,true,1,1,[],0);assert.ok(first);
 assert.deepEqual(p.choose('one',l,true,1,1,[],100),first);
 const blocked={...l,obstacles:[first]};const moved=p.choose('one',blocked,true,1,1,[],200);assert.ok(moved);assert.notDeepEqual(moved,first);
 assert.deepEqual(p.choose('one',l,true,1,1,[],250),moved);assert.deepEqual(p.choose('one',l,true,1,1,[],551),first);
 const motion=visualMotionBounds(first,l,['rotate','float']);assert.ok(motion.width>first.width);
 assert.equal(fitsVisualRect({...l,obstacles:[{x:first.x-.02,y:first.y,width:.01,height:first.height}]},motion),false);
});

test('landscape caption leaves a narrow retreat rather than deleting the object',()=>{
 const l={width:852,height:393,body:{x:.085,y:.085,width:.83,height:.83},face:{x:.275,y:.075,width:.45,height:.35},obstacles:[{x:.188,y:.418,width:.624,height:.104},{x:.088,y:.843,width:.824,height:.157}]};
 assert.ok(placeVisualProp(l,true,1,1));
});
test('video arriving during UI hold inherits visible time and waits for actual display',async()=>{
 let now=100,accept,finish;const notices=[];const s=new VisualSession({now:()=>now,prepare:async()=>{},notice:id=>notices.push(id),generate:async(j,signal,a)=>{accept=a;await new Promise(r=>finish=r);}});s.permission(true,1);s.dispatch('videoheld',intent,'t',1);
 await accept({...asset,id:'base'});s.visible('target');now=2100;s.hold('target');
 await accept({...asset,id:'movie',kind:'video'});assert.equal(s.getSnapshot().ready[0].held,true);assert.equal(s.getSnapshot().ready[0].displayedMs,2000);assert.equal(notices.length,1);
 now=5100;s.visible('target','movie');assert.equal(s.getSnapshot().objects[0].displayedMs,2000);assert.equal(notices.length,2);finish();await flush();
});

async function cacheHarness(run){
 const {visualTicket,visualRoute}=await import('../'+dir+'/test.mjs');const {l,state}=setup();l.visualMode('v','s',true,0);
 const png=await readFile('public/manifestation/chicken-1.png'),store=new Map(),counts={image:0,mask:0,video:0,input:0};
 const env={MANIFESTATION_ENABLED:'true',PUBLIC_BASE_PATH:'/staging',COOKIE_SECRET:'test-secret-'.repeat(4),GENERATION_ENABLED:'true',VISUAL_VIDEO_ENABLED:'true',FAL_KEY:'dummy',ASSETS:{fetch:async()=>new Response(png)},VISUAL_ASSETS:{put:async(id,bytes,options)=>{if(id.startsWith('input-'))counts.input++;store.set(id,{bytes,options});},get:async id=>{const v=store.get(id);return v?{arrayBuffer:async()=>new Response(v.bytes).arrayBuffer(),customMetadata:v.options.customMetadata}:null;}}};
 const bridge=async(op,b)=>{const a=[b.visitor,b.id];switch(op){
 case 'visualPermission':return l.visualPermission(...a);case 'visualLookup':return l.visualLookup(...a,b.generation,b.key);case 'visualLookupAny':return l.visualLookupAny(...a,b.generation,b.keys);case 'visualAlias':return l.visualAlias(...a,b.generation,b.key,b.fromKey);case 'visualReplay':return l.visualReplay(...a,b.generation,b.key);case 'visualClaim':return l.visualClaim(...a,b.generation,b.token,b.key);case 'visualClaimActive':return l.visualClaimActive(...a,b.generation,b.key,b.token);case 'visualStart':return l.visualStart(...a,b.generation,b.token,b.key,b.target,b.duration);case 'visualReserve':return l.visualReserve(...a,b.generation,b.token,b.step,b.cost);case 'visualPublish':return l.visualPublish(...a,b.generation,b.token,b.asset,b.key);case 'visualFinish':return l.visualFinish(...a,b.token,b.code,b.timings);default:throw new Error(op);}};
 let number=0,fail=false;const previous=globalThis.fetch;globalThis.fetch=async(url,init)=>{
 const u=new URL(url);if(u.hostname==='api.fal.ai')return Response.json({prices:[{endpoint_id:u.searchParams.get('endpoint_id'),unit_price:.0001,unit:u.searchParams.get('endpoint_id').includes('video')?'seconds':u.searchParams.get('endpoint_id').includes('birefnet')?'compute seconds':'megapixels',currency:'USD'}]});
 if(u.hostname==='fal.media')return new Response(u.pathname.endsWith('mp4')?'movie':png,{headers:{'Content-Type':u.pathname.endsWith('mp4')?'video/mp4':'image/png'}});
 if(init?.method==='POST'){const stage=u.pathname.includes('video')?'video':u.pathname.includes('birefnet')?'mask':'image';counts[stage]++;await new Promise(r=>setTimeout(r,20));if(fail)return new Response('',{status:503});return Response.json({status_url:'https://queue.fal.run/status',response_url:'https://queue.fal.run/result'});}
 if(u.pathname==='/status')return Response.json({status:'COMPLETED'});
 return Response.json({video:{url:'https://fal.media/result.mp4'},images:[{url:'https://fal.media/result.png'}],image:{url:'https://fal.media/result.png'}});
 };
 const request=async(patch={},extra={})=>{const i={...intent,concept:'crab',targetId:'target-'+(++number),...patch};const signed=await visualTicket({visualIntent:i},env,'v','s',1,permitsVideo(i,i.motionEvidence));const res=await visualRoute(new Request('https://test/api/visual/generate',{method:'POST',body:JSON.stringify({ticket:signed.visualTicket,...extra})}),env,'v','s',bridge);return (await res.text()).trim().split('\n').map(JSON.parse);};
 try{await run({request,counts,l,state,store,fail:()=>{fail=true;}});}finally{globalThis.fetch=previous;}
}
test('resolved source makes repeated video a hit; changing motion reuses image, mask and input',()=>cacheHarness(async({request,counts})=>{
 const first=await request({motion:'walk',motionEvidence:'walk'});assert.equal(first.at(-1).asset?.kind,'video',JSON.stringify(first));assert.deepEqual(counts,{image:1,mask:1,video:1,input:1});
 const again=await request({concept:'カニ',motion:'walking',motionEvidence:'walking'});assert.equal(again.at(-1).asset.id,first.at(-1).asset.id);assert.deepEqual(counts,{image:1,mask:1,video:1,input:1});
 const other=await request({motion:'dance',motionEvidence:'dance'});assert.equal(other.at(-1).asset.kind,'video');assert.deepEqual(counts,{image:1,mask:1,video:2,input:1});
 const reference=await request({action:'replace',motion:'walk',motionEvidence:'walk'},{source:first.at(-1).asset.source});assert.equal(reference.at(-1).asset.id,first.at(-1).asset.id);assert.deepEqual(counts,{image:1,mask:1,video:2,input:1});
}));
test('concurrent image and video share source generation and mask',()=>cacheHarness(async({request,counts})=>{
 const results=await Promise.all([request(),request({motion:'walk',motionEvidence:'walk'})]);assert.ok(results.every(r=>r.at(-1).type==='asset'),JSON.stringify(results));assert.deepEqual(counts,{image:1,mask:1,video:1,input:1});
}));
test('concurrent identical videos share all paid stages',()=>cacheHarness(async({request,counts})=>{
 const results=await Promise.all([request({motion:'walk',motionEvidence:'walk'}),request({motion:'walking',motionEvidence:'walking'})]);assert.ok(results.every(r=>r.at(-1).asset?.kind==='video'),JSON.stringify(results));assert.equal(results[0].at(-1).asset.id,results[1].at(-1).asset.id);assert.deepEqual(counts,{image:1,mask:1,video:1,input:1});
}));
test('refresh within 24h creates a version; refresh failure keeps unexpired asset',()=>cacheHarness(async({request,counts,fail})=>{
 const a=(await request()).at(-1).asset;const b=(await request({regenerate:true})).at(-1).asset;assert.notEqual(a.id,b.id);assert.deepEqual(counts,{image:2,mask:2,video:0,input:0});fail();const failure=await request({regenerate:true});assert.equal(failure[0].asset.id,b.id);assert.equal(failure.at(-1).type,'failed');const reused=await request();assert.equal(reused.at(-1).asset.id,b.id);
}));
test('exact aliases preserve colors, shapes and real motion; light motion needs image only',async()=>{
 const {normalizeVisualIntent}=await import('../'+dir+'/test.mjs');assert.equal(assetDescriptionKey({...intent,motion:'walking'},false),assetDescriptionKey({...intent,concept:'鶏',motion:'歩く'},false));
 assert.notEqual(assetDescriptionKey({...intent,modifiers:['red']},false),assetDescriptionKey({...intent,modifiers:['blue']},false));
 for(const motion of ['walk','run','dance','dribble'])assert.equal(normalizeVisualIntent({...intent,motion}).motion,motion);
 await cacheHarness(async({request,counts})=>{const r=await request({motion:'swaying',motionEvidence:'swaying'});assert.equal(r.at(-1).asset.kind,'image');assert.deepEqual(counts,{image:1,mask:1,video:0,input:0});});
});
test('reuse lifetime is fixed through 24h and 7d, ends at 30d, and private at 24h',()=>{
 for(const days of [0,1,7,29])assert.equal(cacheDecision({...asset,createdAt:0,expiresAt:30*86400000},days*86400000,false),'reuse');assert.equal(cacheDecision({...asset,expiresAt:30*86400000},30*86400000,false),'miss');assert.equal(cacheDecision({...asset,scope:'s',expiresAt:86400000},86400000,false),'miss');
});

test('verified legacy video migrates without paid requests or changing expiry',()=>cacheHarness(async({request,counts,state})=>{
 const {legacyAssetDescriptionKey}=await import('../'+dir+'/test.mjs');const movie=(await request({motion:'walking',motionEvidence:'walking'})).at(-1).asset;
 const cache=state.visual.cache;const stored=Object.values(cache).find(a=>a.id===movie.id);for(const [k,a] of Object.entries(cache))if(a.kind==='video')delete cache[k];
 const key=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode('shared'+legacyAssetDescriptionKey({...intent,concept:'crab',motion:'walking'},false)+':video-v2:new'))).toString('hex');cache[key]=stored;
 const expiry=stored.expiresAt;const replay=await request({motion:'walk',motionEvidence:'walk'},{cacheOnly:true});assert.equal(replay.at(-1).asset.id,movie.id);assert.equal(replay.at(-1).asset.expiresAt,expiry);assert.deepEqual(counts,{image:1,mask:1,video:1,input:1});assert.ok(Object.values(cache).filter(a=>a.id===movie.id).length>=2);
}));
test('stage claims survive restart and cancellation cannot fund a follow-up step',()=>{
 const {l,state}=setup();l.visualMode('v','s',true,0);l.visualStart('v','s',1,'owner','r1','a',30000);l.visualStart('v','s',1,'waiter','r2','b',30000);assert.equal(l.visualClaim('v','s',1,'owner','base').owner,true);assert.equal(l.visualClaim('v','s',1,'waiter','base').owner,false);
 const restored=new Ledger(JSON.parse(JSON.stringify(state)),2000);assert.equal(restored.visualClaimActive('v','s',1,'base','owner'),true);restored.visualCancel('v','s',1,'a','owner');assert.equal(restored.visualClaimActive('v','s',1,'base','owner'),false);assert.throws(()=>restored.visualReserve('v','s',1,'owner','mask',50000),/job_expired/);assert.equal(restored.report().manifestation.reservedUsd,0);
});
