import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {checkVisualConfig} from './staging-visual-preview.mjs';
test('visual preview accepts only staging and its dedicated storage binding',async()=>{
 const config=JSON.parse(await readFile('wrangler.public.jsonc','utf8'));checkVisualConfig(config);
 assert.throws(()=>checkVisualConfig({...config,name:'vayria-web'}));
 assert.throws(()=>checkVisualConfig({...config,r2_buckets:[{binding:'VISUAL_ASSETS',bucket_name:'other'}]}));
});
