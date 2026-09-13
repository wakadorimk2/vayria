import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {checkVisualConfig,enableSharedWorld,enableSharedConversation,checkWorldStorageConfig} from './staging-visual-preview.mjs';
test('shared conversation changes only feature flags and accepts only the private staging RPC binding',async()=>{
 const original=JSON.parse(await readFile('wrangler.public.jsonc','utf8'));const next=enableSharedConversation(original);
 assert.deepEqual({...next.vars,SHARED_WORLD_ENABLED:'false',SHARED_CONVERSATION_ENABLED:'false'},original.vars);
 const storage=JSON.parse(await readFile('wrangler.world.jsonc','utf8'));checkWorldStorageConfig(storage);
 assert.throws(()=>checkWorldStorageConfig({...storage,services:[{binding:'WORLD_EXECUTOR',service:'vayria-web',entrypoint:'WorldExecution'}]}));
 assert.throws(()=>checkWorldStorageConfig({...storage,vars:{SHARED_CONVERSATION_ENABLED:'true',GENERATION_ENABLED:'true'}}));
});
test('shared preview adds one room namespace without changing generation budgets or production',async()=>{
 const original=JSON.parse(await readFile('wrangler.public.jsonc','utf8'));const next=enableSharedWorld(original);
 assert.equal(original.vars.SHARED_WORLD_ENABLED,'false');assert.equal(next.vars.SHARED_WORLD_ENABLED,'true');
 assert.deepEqual({...next.vars,SHARED_WORLD_ENABLED:'false'},original.vars);
 assert.deepEqual(enableSharedWorld(next),next);
 assert.equal(next.durable_objects.bindings.filter(b=>b.name==='WORLD_ROOMS').length,1);
 assert.equal(next.durable_objects.bindings.find(b=>b.name==='WORLD_ROOMS').script_name,'vayria-shared-world-staging');
 assert.deepEqual(next.migrations,[{tag:'v1',new_sqlite_classes:['PublicUsage']}]);
 assert.throws(()=>enableSharedWorld({...original,name:'vayria-web'}));
});
test('persistent storage has no public route and survives removal of the preview binding',async()=>{
 const config=JSON.parse(await readFile('wrangler.world.jsonc','utf8'));checkWorldStorageConfig(config);
 assert.throws(()=>checkWorldStorageConfig({...config,workers_dev:true}));
 assert.throws(()=>checkWorldStorageConfig({...config,name:'vayria-web'}));
 assert.throws(()=>checkWorldStorageConfig({...config,migrations:[{tag:'delete',deleted_classes:['WorldRoom']}]}));
 const production=JSON.parse(await readFile('wrangler.production.jsonc','utf8'));
 assert.equal(production.durable_objects.bindings.some(b=>b.class_name==='WorldRoom'),false);
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
