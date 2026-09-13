import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {checkVisualConfig,enableSharedWorld} from './staging-visual-preview.mjs';
test('shared preview adds one room namespace without changing generation budgets or production',async()=>{
 const original=JSON.parse(await readFile('wrangler.public.jsonc','utf8'));const next=enableSharedWorld(original);
 assert.equal(original.vars.SHARED_WORLD_ENABLED,'false');assert.equal(next.vars.SHARED_WORLD_ENABLED,'true');
 assert.deepEqual({...next.vars,SHARED_WORLD_ENABLED:'false'},original.vars);
 assert.deepEqual(enableSharedWorld(next),next);
 assert.equal(next.durable_objects.bindings.filter(b=>b.name==='WORLD_ROOMS').length,1);
 assert.throws(()=>enableSharedWorld({...original,name:'vayria-web'}));
});
test('visual preview accepts only staging and its dedicated storage binding',async()=>{
 const config=JSON.parse(await readFile('wrangler.public.jsonc','utf8'));checkVisualConfig(config);
 assert.throws(()=>checkVisualConfig({...config,name:'vayria-web'}));
 assert.throws(()=>checkVisualConfig({...config,r2_buckets:[{binding:'VISUAL_ASSETS',bucket_name:'other'}]}));
});

test('production storage is private and separate from staging',async()=>{
 const production=JSON.parse(await readFile('wrangler.production.jsonc','utf8'));
 const staging=JSON.parse(await readFile('wrangler.public.jsonc','utf8'));
 assert.equal(production.r2_buckets[0].binding,'VISUAL_ASSETS');
 assert.equal(production.r2_buckets[0].bucket_name,'vayria-production-visual-assets');
 assert.notEqual(production.r2_buckets[0].bucket_name,staging.r2_buckets[0].bucket_name);
 assert.notEqual(production.vars.MANIFESTATION_ENABLED,'true');
});
