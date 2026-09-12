import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {checkVisualConfig} from './staging-visual-preview.mjs';
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
