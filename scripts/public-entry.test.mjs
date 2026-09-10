import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
const dir = 'node_modules/.tmp/public-entry';
await mkdir(dir, { recursive: true });
const sessionBuild = await build({ entryPoints: ['src/public/session.ts'], bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'public-runtime', setup(b) { b.onLoad({ filter: /runtimeConfig\.ts$/ }, () => ({ contents: "export const runtimeConfig = { mode: 'public' };", loader: 'ts' })); } }] });
await writeFile(`${dir}/session.mjs`, sessionBuild.outputFiles[0].text);
const session = await import(`../${dir}/session.mjs`);
test('admission is single-flight, cancellable, and rejects stale or hidden continuations', async () => {
  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = new EventTarget(); globalThis.document = { hidden: false };
  let resolveAdmission; let requests = 0; let actions = 0;
  const unregister = session.registerPublicSessionRequest(() => { requests++; return new Promise(resolve => { resolveAdmission = resolve; }); });
  const action = () => { actions++; };
  try {
    session.pausePublic();
    const first = session.runPublicAction(action);
    assert.equal(await session.runPublicAction(action), false);
    assert.equal(requests, 1);
    session.activatePublic({ id: 'one', expires: Date.now() + 60000 }); resolveAdmission(true);
    assert.equal(await first, true); assert.equal(actions, 1);
    session.pausePublic();
    const cancelled = session.runPublicAction(action);
    session.cancelPublicAction(); resolveAdmission(true);
    assert.equal(await cancelled, false); assert.equal(actions, 1);
    const hidden = session.runPublicAction(action);
    session.activatePublic({ id: 'two', expires: Date.now() + 60000 });
    document.hidden = true; resolveAdmission(true);
    assert.equal(await hidden, false); assert.equal(actions, 1);
    document.hidden = false; session.pausePublic();
    const stopped = session.runPublicAction(action);
    session.pausePublic(); resolveAdmission(true);
    assert.equal(await stopped, false);
    const denied = session.runPublicAction(action); resolveAdmission(false);
    assert.equal(await denied, false); assert.equal(actions, 1);
    const retry = session.runPublicAction(action);
    session.activatePublic({ id: 'three', expires: Date.now() + 60000 }); resolveAdmission(true);
    assert.equal(await retry, true); assert.equal(actions, 2);
  } finally { unregister(); session.pausePublic(); Object.assign(globalThis, previous); }
});
const serverBuild = await build({ stdin: { contents: 'export { readChatRequest } from "./server/chatValidation"; export { generateInteractiveResponse } from "./server/chatGeneration";', resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', platform: 'node',
  plugins: [{ name: 'fake-provider', setup(b) { b.onLoad({ filter: /[\\/]llmRuntime\.ts$/ }, () => ({ loader: 'ts', contents: `
    export function modelForProfile() { return 'mock'; }
    export async function processStructuredLlm(request) {
      globalThis.__entryRequests.push(request);
      return { text: JSON.stringify({ text: 'こんにちは。少しお話しする？', emotion: 'neutral', activatedCards: ['chicken'], speechAct: 'answer', expressionLevel: 'low' }), actualModel: 'mock', telemetry: {} };
    }` })); } }] });
await writeFile(`${dir}/server.mjs`, serverBuild.outputFiles[0].text);
const server = await import(`../${dir}/server.mjs`);
test('only explicit manual greetings get welcome instructions; validation rejects other modes and values', async () => {
  const base = { mode: 'manual', message: 'こんにちは', history: [], brainCardIds: ['chicken','suspicious','sleepy','rain','gigantic'], forcedCardId: null, recentExpressionLevels: [] };
  const greeting = server.readChatRequest({ ...base, greeting: true });
  assert.equal(greeting.greeting, true);
  assert.equal(server.readChatRequest(base).greeting, undefined);
  for (const value of [false, 'true', {}, null]) assert.throws(() => server.readChatRequest({ ...base, greeting: value }));
  assert.throws(() => server.readChatRequest({ ...base, mode: 'voice', greeting: true }));
  assert.throws(() => server.readChatRequest({ ...base, mode: 'autonomous', greeting: true }));
  globalThis.__entryRequests = [];
  const tracker = { callCount: 0, async run(_meta, action) { this.callCount++; return action(() => {}, () => {}, async action => action()); } };
  const llm = { apiKey: 'mock', signal: new AbortController().signal, runtime: { profile: 'nano-implicit', serviceTier: 'standard', fallbackEnabled: false }, onFallback() {} };
  try {
    for (const flag of [true, undefined]) {
      await server.generateInteractiveResponse(llm, 'manual', flag ? 'こんにちは' : '今どんな気分？', [], greeting.brainCardIds, null,
        greeting.performanceContext, greeting.characterIdentity, greeting.programContext, tracker, null, false, [], flag);
    }
    assert.equal(globalThis.__entryRequests.length, 2);
    assert.match(globalThis.__entryRequests[0].staticPrompt, /exactly one easy, low-pressure question/);
    assert.doesNotMatch(globalThis.__entryRequests[1].staticPrompt, /For this greeting/);
    assert.equal(globalThis.__entryRequests[0].userMessage, 'こんにちは');
  } finally { delete globalThis.__entryRequests; }
});
