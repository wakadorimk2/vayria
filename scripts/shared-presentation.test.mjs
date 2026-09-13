import {test} from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
const load=async path=>{const b=await build({entryPoints:[path],bundle:true,write:false,format:'esm',platform:'node'});return import('data:text/javascript;base64,'+Buffer.from(b.outputFiles[0].text).toString('base64'));};
const {ReplyPlayback}=await load('src/sharedWorld/replyPlayback.ts');
const {WorldPhysics}=await load('src/sharedWorld/physics.ts');
const {spriteSize,restingPosition,spawnPosition}=await load('src/sharedWorld/spriteLayout.ts');

test('one tab owns one reply, including remounts, duplicate notices, cancellation and new generations',()=>{
  const playback=new ReplyPlayback();let stopped=0;
  assert.equal(playback.claim('room:0:one',()=>stopped++),true);
  assert.equal(playback.claim('room:0:one',()=>assert.fail('duplicate owner')),false);
  playback.release('room:0:one');assert.equal(stopped,1);
  assert.equal(playback.claim('room:0:one',()=>{}),false);
  assert.equal(playback.claim('room:0:two',()=>stopped++),true);
  assert.equal(playback.claim('room:1:one',()=>stopped++),true);assert.equal(stopped,2);
  playback.release('room:0:two');assert.equal(stopped,2);
  playback.stop();assert.equal(stopped,3);
  assert.equal(playback.claim('other:1:one',()=>{}),true);
});
test('dense 24 and 96 bodies stay finite, preserve identity on material updates and resize',()=>{
  for(const count of [24,96]){
    const p=new WorldPhysics();p.resize(854,1270);const size=spriteSize(854,1270);
    const specs=Array.from({length:count},(_,i)=>({id:String(i),x:100+i%6*120,y:50+Math.floor(i/6)*size*.9,size,effects:[]}));p.sync(specs);
    for(let i=0;i<600;i++)p.step(1000/60,'normal');
    for(const {body} of p.bodies.values())assert.ok(Number.isFinite(body.position.y)&&Number.isFinite(body.velocity.x));
    const before=p.bodies.get('0').body;const at={...before.position};p.sync(specs.map(s=>({...s})));
    assert.equal(p.bodies.get('0').body,before);assert.deepEqual(before.position,at);
    p.resize(1270,854);p.sync(specs.map(s=>({...s,size:spriteSize(1270,854)})));
    for(let i=0;i<60;i++)p.step(1000/60,'water');for(let i=0;i<60;i++)p.step(1000/60,'zero');
    assert.equal(p.bodies.size,count);p.dispose();
  }
});
test('responsive sizes and reduced-motion pile use the same large footprint',()=>{
  assert.equal(spriteSize(390,844),72);assert.equal(spriteSize(1024,1366),168);
  assert.equal(spriteSize(390,844,1.5),108);assert.equal(spriteSize(390,844,.65),46.800000000000004);
  const bottom=restingPosition(0,390,844,72),above=restingPosition(6,390,844,72);
  assert.ok(above.y<bottom.y);assert.ok(bottom.x>0&&bottom.y<=844-36);
  const routed=spawnPosition(195,50,72,390,844,[{x:.08,y:.1,width:.84,height:.35}]);
  assert.ok(routed.y>844*.45); // A narrow screen must not pile objects on the face's collision wall.
});
test('tutorial dismissal persists, restores on reads, and tolerates disabled storage',async()=>{
  const previous={window:globalThis.window,localStorage:globalThis.localStorage};let stored=null;let events=0;
  globalThis.window=new EventTarget();window.addEventListener('vayria-tutorial-dismiss',()=>events++);
  globalThis.localStorage={getItem:()=>stored,setItem:(_,value)=>stored=value};
  try{const t=await load('src/public/tutorial.ts');assert.equal(t.tutorialDismissed(),false);t.dismissTutorial();assert.equal(t.tutorialDismissed(),true);assert.equal(events,1);
    globalThis.localStorage={getItem:()=>{throw Error('denied');},setItem:()=>{throw Error('denied');}};
    assert.equal(t.tutorialDismissed(),false);t.dismissTutorial();assert.equal(events,2);
  }finally{Object.assign(globalThis,previous);}
});
