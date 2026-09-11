import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { createHmac } from 'node:crypto';
const bundle = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2023', external: ['cloudflare:workers'] });

test('Preview admission and repeated visits redirect to the app without serving a file', async () => {
  const secret = 'preview-test-secret-'.repeat(3);
  const base = 'https://test.example';
  const assetRequests = [];
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'preview', modules: true,
    script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { USAGE: { className: 'PublicUsage', useSQLite: true } },
    bindings: { REQUIRE_PREVIEW_ACCESS: 'true', PREVIEW_SECRET: secret },
    serviceBindings: { ASSETS: request => { assetRequests.push(new URL(request.url).pathname); return new Response('app', { headers: { 'Content-Type': 'text/html' } }); } },
  }] }));
  const payload = Buffer.from(JSON.stringify({ purpose: 'preview', exp: Date.now() + 60000 })).toString('base64url');
  const ticket = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
  try {
    for (const path of ['/exhibition', '/exhibition/']) {
      assert.equal((await mf.dispatchFetch(base + path)).status, 401);
    }
    const submit = (value, cookie = '', origin = base) => mf.dispatchFetch(base + '/preview', {
      method: 'POST', redirect: 'manual', headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ticket: value }).toString(),
    });
    assert.equal((await submit('invalid')).status, 401);
    assert.equal((await submit(ticket, '', 'https://other.example')).status, 401);
    const first = await submit(ticket);
    assert.equal(first.status, 303);
    assert.equal(first.headers.get('location'), '/');
    assert.match(first.headers.get('content-type'), /^text\/html/);
    assert.equal(first.headers.get('content-disposition'), null);
    const cookie = first.headers.get('set-cookie').split(';')[0];
    const repeated = await submit(ticket, cookie);
    assert.equal(repeated.status, 303);
    assert.equal(repeated.headers.get('location'), '/');
    const visit = await mf.dispatchFetch(base + '/preview', { headers: { Cookie: cookie }, redirect: 'manual' });
    assert.equal(visit.status, 303);
    assert.equal((await submit(ticket, cookie, 'https://other.example')).status, 403);
    assert.deepEqual(assetRequests, []);
    const app = await mf.dispatchFetch(base + '/', { headers: { Cookie: cookie } });
    assert.equal(await app.text(), 'app');
    assert.deepEqual(assetRequests, ['/']);
    for (const path of ['/exhibition', '/exhibition/']) {
      const registration = await mf.dispatchFetch(base + path, { headers: { Cookie: cookie } });
      assert.equal(registration.status, 200);
      assert.equal(await registration.text(), 'app');
      assert.equal(registration.headers.get('x-robots-tag'), 'noindex');
    }
    assert.deepEqual(assetRequests, ['/', '/', '/']);
  } finally { await mf.dispose(); }
});
test('Worker admission, SQLite serialization, tickets and budget reject before provider calls', async () => {
  const calls = []; const challengeTokens = new Set(); const secret = 'local-test-secret-'.repeat(3);
  const mf = new Miniflare(convertV4MiniflareOptions({ workers: [{ name: 'public', modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-09-07', compatibilityFlags: ['nodejs_compat'],
    durableObjects: { USAGE: { className: 'PublicUsage', useSQLite: true } },
    bindings: { COOKIE_SECRET: secret, IP_SECRET: secret, ADMIN_SECRET: secret, OPENAI_API_KEY: 'mock-openai', AIVIS_API_KEY: 'mock-aivis',
      AIVIS_MODEL_UUID: '7fc08a41-b64d-456d-8b22-8e1284674775', AIVIS_SPEAKER_UUID: '8e2dfde9-a155-4bd8-b451-80832ad5e8ac',
      TURNSTILE_SECRET: 'mock', TURNSTILE_SITE_KEY: 'mock', GENERATION_ENABLED: 'true', REQUIRE_PREVIEW_ACCESS: 'false', PUBLIC_HOSTNAME: 'test.example' },
    serviceBindings: { ASSETS: () => new Response('asset') },
    outboundService: async request => {
      const path = new URL(request.url).pathname; calls.push(path);
      if (path.endsWith('/siteverify')) {
        const token = new URLSearchParams(await request.text()).get('response');
        const success = !challengeTokens.has(token); challengeTokens.add(token);
        return Response.json({ success, hostname: 'test.example', action: 'session' });
      }
      if (path === '/v1/responses') {
        const input = await request.json(); assert.equal(input.model, 'gpt-5-nano'); assert.equal(input.service_tier, 'default');
        const text = JSON.stringify({ text: '今日はちょっと慎重に、足元を確かめながら進みたいな。', emotion: 'neutral' });
        const events = [{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: {
          model: 'gpt-5-nano', usage: { input_tokens: 100, output_tokens: 50 }, service_tier: 'default',
        } }];
        return new Response(events.map(value => `data: ${JSON.stringify(value)}\n\n`).join(''), { headers: { 'Content-Type': 'text/event-stream' } });
      }
      if (path === '/v1/tts/synthesize') {
        const input = await request.json(); assert.equal(input.speaker_uuid, '8e2dfde9-a155-4bd8-b451-80832ad5e8ac');
        assert.equal(input.model_uuid, '7fc08a41-b64d-456d-8b22-8e1284674775');
        return new Response(new Uint8Array([73, 68, 51]), { headers: { 'Content-Type': 'audio/mpeg' } });
      }
      if (path === '/v1/audio/transcriptions') {
        const input = await request.formData(); assert.equal(input.get('model'), 'gpt-4o-mini-transcribe');
        return Response.json({ text: 'こんにちは', usage: { input_tokens: 20, output_tokens: 5 } });
      }
      throw new Error('Unexpected provider route');
    },
  }] }));
  try {
    const base = 'https://test.example';
    const bootstrap = await mf.dispatchFetch(base + '/api/session'); assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get('set-cookie').split(';')[0];
    const headers = { Cookie: cookie, Origin: base, 'Content-Type': 'application/json', 'CF-Connecting-IP': '192.0.2.1' };
    const post = (path, body, extra = {}) => mf.dispatchFetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const starts = await Promise.all(Array.from({ length: 5 }, (_, i) => post('/api/session', { token: 'challenge' + i })));
    const sessions = await Promise.all(starts.map(r => r.json()));
    assert.equal(new Set(sessions.map(s => s.session.id)).size, 1);
    headers['X-Vayria-Session'] = sessions[0].session.id;
    const before = calls.length;
    assert.equal((await post('/api/tts', { text: 'arbitrary text' })).status, 403);
    assert.equal((await post('/api/card-preview', { cardId: 'unknown' })).status, 400);
    assert.equal(calls.length, before);
    const card = { cardId: 'chicken', performanceContext: { callbackTendency: 0, fragmentation: 0, semanticBiases: [] } };
    const previews = await Promise.all([post('/api/card-preview', card), post('/api/card-preview', card)]);
    assert.deepEqual(previews.map(r => r.status).sort(), [200, 429]);
    const reply = await previews.find(r => r.status === 200).json(); assert.ok(reply.ttsTicket);
    const speech = await post('/api/tts', { ticket: reply.ttsTicket }); assert.equal(speech.status, 200); await speech.arrayBuffer();
    const count = calls.length;
    assert.equal((await post('/api/tts', { ticket: reply.ttsTicket })).status, 409); assert.equal(calls.length, count);
    const wav = new ArrayBuffer(32044); const view = new DataView(wav);
    const ascii = (offset, value) => { for (let i = 0; i < value.length; i++) view.setUint8(offset + i, value.charCodeAt(i)); };
    ascii(0, 'RIFF'); view.setUint32(4, 32036, true); ascii(8, 'WAVE'); ascii(12, 'fmt '); view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
    view.setUint16(32, 2, true); view.setUint16(34, 16, true); ascii(36, 'data'); view.setUint32(40, 32000, true);
    const stt = await mf.dispatchFetch(base + '/api/transcribe', { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: wav });
    assert.equal(stt.status, 200); assert.equal((await stt.json()).text, 'こんにちは');
    const paidCount = calls.length;
    const payload = Buffer.from(JSON.stringify({ purpose: 'admin', exp: Date.now() + 60000 })).toString('base64url');
    const auth = payload + '.' + createHmac('sha256', secret).update(payload).digest('base64url');
    assert.equal((await post('/api/admin', { op: 'configure', patch: { dayBudget: 1 } }, { Authorization: 'Bearer ' + auth })).status, 200);
    assert.equal((await post('/api/card-preview', card)).status, 429); assert.equal(calls.length, paidCount);
    const report = await (await post('/api/admin', { op: 'report' }, { Authorization: 'Bearer ' + auth })).json();
    assert.equal(report.recentByKind.card.started, 1);
    assert.equal(report.recentByKind.card.rejected, 2);
    assert.deepEqual(report.recentByKind.card.failures, { busy: 1, daily_budget: 1 });
    assert.equal(report.recentByKind.card.timings.generationMs.samples, 1);
    assert.equal(report.recentByKind.card.llmCalls, 1);
    assert.equal(report.recentByKind.card.actualModels['gpt-5-nano'], 1);
    assert.equal(report.recentByKind.tts.timings.ttsFirstByteMs.samples, 1);
    assert.equal(report.recentByKind.tts.timings.ttsTotalMs.samples, 1);
    assert.equal(report.recentByKind.tts.failures.ticket_used, 1);
    assert.equal(JSON.stringify(report).includes('慎重'), false);
    assert.equal((await mf.dispatchFetch(base + '/api/unknown')).status, 404);
    await mf.dispatchFetch(base + '/api/session', { method: 'DELETE', headers });
    assert.equal((await post('/api/session', { token: 'challenge0' })).status, 403);
  } finally { await mf.dispose(); }
});

test('measurement persistence failures do not fail successful generation or replace a rejection', async () => {
  const isolated = await build({ entryPoints: ['worker/index.ts'], bundle: true, write: false, format: 'esm', platform: 'node', target: 'es2023',
    plugins: [{ name: 'ledger-stub', setup(b) { b.onLoad({ filter: /worker[\\/]usage\.ts$/ }, () => ({ contents: 'export class PublicUsage {}', loader: 'ts' })); } }] });
  const { mkdir, writeFile } = await import('node:fs/promises');
  await mkdir('node_modules/.tmp/public-isolated', { recursive: true });
  await writeFile('node_modules/.tmp/public-isolated/worker.mjs', isolated.outputFiles[0].text);
  const { default: worker } = await import('../node_modules/.tmp/public-isolated/worker.mjs');
  const secret = 'mock-secret-'.repeat(4); const calls = []; let reject = false;
  const token = Buffer.from(JSON.stringify({ purpose: 'visitor', id: 'v', exp: Date.now() + 60000 })).toString('base64url');
  const signed = token + '.' + createHmac('sha256', secret).update(token).digest('base64url');
  const env = { COOKIE_SECRET: secret, GENERATION_ENABLED: 'true', OPENAI_API_KEY: 'mock', AIVIS_API_KEY: 'mock', AIVIS_MODEL_UUID: 'mock',
    USAGE: { idFromName: () => 'test', get: () => ({ fetch: async (_url, init) => {
      const input = JSON.parse(init.body); calls.push(input);
      if (['finish', 'reject'].includes(input.op)) throw new Error('storage failed');
      if (input.op === 'begin') return reject ? Response.json({ code: 'card_limit', retryAt: 123 }, { status: 429 }) : Response.json({ limits: { usdJpy: 150 }, expires: Date.now() + 60000 });
      return Response.json({});
    } }) } };
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response([
    { type: 'response.output_text.delta', delta: JSON.stringify({ text: '少し慎重に進みたいな。', emotion: 'neutral' }) },
    { type: 'response.completed', response: { model: 'gpt-5-nano', usage: { input_tokens: 10, output_tokens: 10 }, service_tier: 'default' } },
  ].map(value => 'data: ' + JSON.stringify(value) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
  const request = () => new Request('https://test/api/card-preview', { method: 'POST', headers: { Origin: 'https://test', Cookie: '__Host-vayria=' + signed, 'X-Vayria-Session': 's' },
    body: JSON.stringify({ cardId: 'chicken', performanceContext: { callbackTendency: 0, fragmentation: 0, semanticBiases: [] } }) });
  try {
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 200); assert.ok((await response.json()).ttsTicket);
    assert.equal(calls.filter(c => c.op === 'finish').length, 1);
    assert.equal(calls.find(c => c.op === 'finish').measurements.llmCalls, 1);
    reject = true;
    const refused = await worker.fetch(request(), env);
    assert.equal(refused.status, 429); assert.equal((await refused.json()).code, 'card_limit');
    assert.equal(calls.filter(c => c.op === 'finish').length, 1);
    assert.equal(calls.filter(c => c.op === 'reject').length, 1);
  } finally { globalThis.fetch = previousFetch; }
});

test('staging visual routes pass through the real Worker entry and never invoke paid providers for mode changes', async()=>{
 const secret='visual-entry-secret-'.repeat(3),base='https://test.example';
 const sign=value=>{const p=Buffer.from(JSON.stringify(value)).toString('base64url');return p+'.'+createHmac('sha256',secret).update(p).digest('base64url');};
 for(const enabled of ['true','false']){
  const calls=[];const mf=new Miniflare(convertV4MiniflareOptions({workers:[{name:'visual-entry-'+enabled,modules:true,script:bundle.outputFiles[0].text,compatibilityDate:'2026-09-07',compatibilityFlags:['nodejs_compat'],durableObjects:{USAGE:{className:'PublicUsage',useSQLite:true}},bindings:{PUBLIC_BASE_PATH:'/staging',MANIFESTATION_ENABLED:enabled,COOKIE_SECRET:secret,IP_SECRET:secret,PREVIEW_SECRET:secret,REQUIRE_PREVIEW_ACCESS:'true',GENERATION_ENABLED:'true',TURNSTILE_SECRET:'test',PUBLIC_HOSTNAME:'test.example'},serviceBindings:{ASSETS:()=>new Response('app')},outboundService:request=>{calls.push(new URL(request.url).pathname);if(request.url.includes('/siteverify'))return Response.json({success:true,hostname:'test.example',action:'session'});throw new Error('Unexpected paid provider');}}]}));
  try{
   const preview='__Host-vayria-staging-preview='+sign({purpose:'preview',exp:Date.now()+60000});
   const headers={Origin:base,'Content-Type':'application/json',Cookie:preview,'CF-Connecting-IP':'192.0.2.20'};
   const post=(path,body,extra={})=>mf.dispatchFetch(base+'/staging'+path,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
   assert.equal((await post('/api/visual/mode',{enabled:true,generation:0},{Cookie:''})).status,403);
   assert.equal((await post('/api/visual/mode',{enabled:true,generation:0})).status,403);
   const bootstrap=await mf.dispatchFetch(base+'/staging/api/session',{headers});headers.Cookie+='; '+bootstrap.headers.get('set-cookie').split(';')[0];
   const started=await (await post('/api/session',{token:'test'})).json();headers['X-Vayria-Session']=started.session.id;
   const mode=(on,generation)=>post('/api/visual/mode',{enabled:on,generation});
   if(enabled==='false'){assert.equal((await mode(true,0)).status,404);continue;}
   assert.deepEqual(await (await mode(false,0)).json(),{enabled:false,generation:1});
   assert.deepEqual(await (await mode(true,1)).json(),{enabled:true,generation:2});
   const visitor=JSON.parse(Buffer.from(bootstrap.headers.get('set-cookie').split('=')[1].split('.')[0],'base64url').toString()).id;
   const generate=async(type,concept)=>{
    const ticket=sign({purpose:'visual',exp:Date.now()+60000,visitor,session:started.session.id,generation:2,token:crypto.randomUUID(),video:false,
     intent:{type,concept,action:'add',modifiers:[],targetId:type==='background'?'background':'chicken-test',motion:'',motionEvidence:'',sharing:'general',regenerate:false}});
    return post('/api/visual/generate',{ticket});
   };
   // Exercise the real Durable Object transport: a cache miss must remain null, not {}.
   const chicken=await generate('prop','chicken');assert.equal(chicken.status,200);
   const asset=await chicken.json();assert.equal(asset.type,'asset');assert.equal(asset.asset.url,'/staging/manifestation/chicken-1.png');
   const background=await generate('background','sea');assert.equal(background.status,200);
   assert.deepEqual(await background.json(),{type:'failed',code:'background_not_adopted'});
   assert.deepEqual(await (await mode(false,2)).json(),{enabled:false,generation:3});
   assert.equal((await mode(true,1)).status,409);
   assert.deepEqual(await (await mode(true,3)).json(),{enabled:true,generation:4});
   // Reload initialization always sends OFF, even when its local generation starts at zero.
   assert.deepEqual(await (await mode(false,0)).json(),{enabled:false,generation:5});
   assert.equal((await post('/api/visual/not-a-route',{})).status,404);
   assert.equal((await post('/api/not-a-route',{})).status,404);
   assert.equal((await post('/api/visual/mode',{enabled:true,generation:5},{'X-Vayria-Session':'expired'})).status,401);
   await mf.dispatchFetch(base+'/staging/api/session',{method:'DELETE',headers});
   assert.equal((await mode(true,5)).status,401);
   assert.deepEqual(calls,['/turnstile/v0/siteverify']);
  }finally{await mf.dispose();}
 }
});
