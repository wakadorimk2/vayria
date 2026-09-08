import { createInitialAutonomyState, observeAutonomyEvidence, selectAutonomyCandidate } from '../src/conversation/autonomyState.js';
import { INITIAL_AUTONOMOUS_CONTEXT } from '../src/conversation/autonomousContext.js';
import type { InteractionTimelineEvent } from '../src/conversation/interactionTimeline.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createConversationRuntime, type ConversationDependencies, type ConversationOptions } from '../src/conversation/conversationRuntime.js';
import type { PerformancePlayback, PerformancePlaybackCallbacks, PerformancePlaybackResult } from '../src/performer/performancePlayback.js';
import type { PerformancePlan, PerformanceResult } from '../src/performer/types.js';
import { createSemanticDialogueHistory } from '../src/conversation/semanticDialogueHistory.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const response = { interactionAction: 'take_floor', backchannelCue: 'none', text: 'お返事です。', emotion: 'neutral', activatedCards: ['card-a'], speechAct: 'answer', expressionLevel: 'low', internalDelta: { reasonUpdates: [] } };
const cards = { brainCardIds: ['card-a'], forcedCardId: null };
const plan = (id: string) => ({ planId: id, trigger: { kind: 'manual_message', message: 'こんにちは' }, intent: 'speak', timing: { motionLeadMs: 0, postSpeechHoldMs: 0, motionPreparationTimeoutMs: 0 } }) as unknown as PerformancePlan;
const result = { speechStartedAt: 1, speechEndedAt: 2 };
async function flush() { for (let i = 0;i < 30;i++) await Promise.resolve(); }

function fixture(options: ConversationOptions = {}) {
  const requests: { url: string; body: Record<string, unknown>; signal: AbortSignal | null | undefined }[] = [];
  const plays: { pending: ReturnType<typeof deferred<PerformancePlaybackResult | null>>; callbacks?: PerformancePlaybackCallbacks }[] = [];
  const results: PerformanceResult[] = [];
  const timeline: InteractionTimelineEvent[] = [];
  const captureEvents: string[] = [];
  const events: string[] = [];
  let turn = 0;
  let tts: () => Promise<Response> = async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/wav' } });
  let chat: () => Promise<Response> = async () => Response.json(response);
  const playback: PerformancePlayback = {
    holdAudioCapture() { captureEvents.push('hold'); return () => { captureEvents.push('release'); }; },
    prepare() { }, stop() { },
    play(_plan, _source, callbacks) {
      const pending = deferred<PerformancePlaybackResult | null>();
      plays.push({ pending, callbacks });
      return pending.promise;
    },
  };
  const dependencies: ConversationDependencies = {
    config: { streamingSpeechEnabled: true, earlySpeechLeadEnabled: false, cloudTtsStreamPlaybackEnabled: false } as ConversationDependencies['config'],
    fetch: async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)), signal: init?.signal });
      return String(url).endsWith('/chat') ? chat() : tts();
    },
    createEventEmitter: () => ({ turnId: `turn-${++turn}`, runId: undefined, emit(event) { events.push(event); } }),
    now: () => 100, monotonicNow: () => 100,
    setTimeout: () => 1, clearTimeout() { }, prefersReducedMotion: () => true,
  };
  const runtimeOptions = { ...options, onPerformanceResult: (r: PerformanceResult) => results.push(r), onInteractionTimelineEvent: (event: InteractionTimelineEvent) => timeline.push(event) };
  const runtime = createConversationRuntime(playback, runtimeOptions, dependencies);
  return { runtime, requests, plays, results, timeline, captureEvents, events, updateOptions(next: ConversationOptions) { Object.assign(runtimeOptions, next); runtime.updateOptions(runtimeOptions); }, setTts(value: typeof tts) { tts = value; }, setChat(value: typeof chat) { chat = value; }, send(id: string) { return runtime.sendManual('こんにちは', cards, () => { }, plan(id)); } };
}

test('delivery history keeps user-only turns and deduplicates completed units', () => {
  const history = createSemanticDialogueHistory();
  history.beginTurn('one', 'question', 1);
  assert.deepEqual(history.toMessages(), [{ role: 'user', content: 'question' }]);
  assert.equal(history.appendDeliveredUnit('one', 0, 'first'), 'first');
  assert.equal(history.appendDeliveredUnit('one', 0, 'first'), null);
  assert.equal(history.appendDeliveredUnit('one', 1, 'second'), 'firstsecond');
  history.clear();
  assert.equal(history.appendDeliveredUnit('one', 2, 'late'), null);
  assert.deepEqual(history.toMessages(), []);
});

test('failed playback retains the user but not an unheard assistant reply', async () => {
  const f = fixture(); const pending = f.send('one'); await flush();
  assert.equal(f.plays.length, 1);
  f.plays[0].pending.reject(new Error('audio failed')); await pending;
  const next = f.send('two'); await flush();
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/chat'))[1].body.history, [{ role: 'user', content: 'こんにちは' }]);
  f.plays[1].pending.resolve(result); await next;
  assert.deepEqual(f.results.at(-1)?.spokenText, response.text);
});

test('old completion after reset cannot change a new turn or restore cleared history', async () => {
  const f = fixture(); const old = f.send('old'); await flush();
  f.runtime.resetConversation();
  const next = f.send('next'); await flush();
  f.plays[0].pending.resolve(result); await old;
  assert.notEqual(f.runtime.getSnapshot().status, 'idle');
  assert.equal(f.results.some(r => r.planId === 'old' && r.outcome === 'completed'), false);
  f.plays[1].pending.resolve(result); await next;
  const third = f.send('third'); await flush();
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/chat'))[2].body.history, [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: response.text }]);
  f.plays[2].pending.resolve(result); await third;
});

test('text-only response is retained without starting playback', async () => {
  const f = fixture({ isMuted: true }); await f.send('text'); await f.send('next');
  assert.equal(f.plays.length, 0);
  assert.deepEqual(f.requests[1].body.history, [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: response.text }]);
});

test('greeting purpose is separate from visible input and never leaks into the next turn', async () => {
  const f = fixture({ isMuted: true });
  await f.runtime.sendManual('こんにちは', cards, () => {}, plan('greeting'), undefined, undefined, undefined, true);
  assert.equal(f.requests[0].body.greeting, true);
  assert.equal(f.requests[0].body.message, 'こんにちは');
  await f.send('ordinary');
  assert.equal(f.requests[1].body.greeting, undefined);
  assert.deepEqual(f.requests[1].body.history, [
    { role: 'user', content: 'こんにちは' }, { role: 'assistant', content: response.text },
  ]);
});

test('reset discards late TTS failures after speech audio completed', async () => {
  const f = fixture();
  const pending = f.send('previous-visitor');
  await flush();
  f.plays[0].callbacks?.onAudioComplete?.(2);
  f.runtime.resetConversation();
  f.plays[0].pending.reject(new Error('late TTS failure'));
  assert.equal(await pending, false);
  assert.equal(f.runtime.getSnapshot().error, '');
  assert.equal(f.runtime.getSnapshot().status, 'idle');
  assert.equal(f.runtime.getSnapshot().reply, '');
  const next = f.send('next-visitor');
  await flush();
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/chat'))[1].body.history, []);
  f.plays[1].pending.resolve(result);
  assert.equal(await next, true);
});

test('mute during playback does not promote generated text to delivered history', async () => {
  const f = fixture(); const old = f.send('old'); await flush();
  f.runtime.updateOptions({ isMuted: true });
  f.plays[0].pending.resolve(result); await old;
  await f.send('text');
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/chat'))[1].body.history, [{ role: 'user', content: 'こんにちは' }]);
});

test('replacing the playback port cancels the old turn and uses the new avatar port', async () => {
  const f = fixture();
  const old = f.send('old'); await flush();
  let starts = 0;
  f.runtime.updatePlayback({
    prepare() {}, stop() {},
    async play() { starts += 1; return result; },
  });
  assert.equal(await f.send('new'), true);
  assert.equal(starts, 1);
  f.plays[0].pending.reject(new Error('old port completed late'));
  assert.equal(await old, false);
  assert.equal(f.runtime.getSnapshot().status, 'idle');
  assert.equal(f.results.at(-1)?.planId, 'new');
});

function streamingResponse() {
  return new Response([
    { type: 'speech_unit', index: 0, text: '前半。', response },
    { type: 'speech_unit', index: 1, text: '後半。', response },
    { type: 'done', response: { ...response, text: '前半。後半。' } },
  ].map(event => JSON.stringify(event)).join('\n') + '\n', { headers: { 'content-type': 'application/x-ndjson' } });
}

for (const source of ['manual', 'voice'] as const) {
  for (const streaming of [false, true]) {
    for (const isExhibitionMode of [false, true]) {
      test(`muted ${source}, streaming=${streaming}, exhibition=${isExhibitionMode} completes with visible text and no audio`, async () => {
        const f = fixture({ isMuted: true, isExhibitionMode });
        f.setChat(async () => streaming ? streamingResponse() : Response.json(response));
        const send = (id: string) => source === 'manual' ? f.send(id) : f.runtime.sendVoice('こんにちは', cards, () => {}, plan(id));
        const text = streaming ? '前半。後半。' : response.text;
        assert.equal(await send('first'), true);
        assert.equal(f.runtime.getSnapshot().reply, text);
        assert.equal(f.runtime.getSnapshot().isSubtitleVisible, isExhibitionMode);
        assert.equal(f.runtime.getSnapshot().status, 'idle');
        assert.equal(f.runtime.getSnapshot().isBusy, false);
        assert.equal(f.results.at(-1)?.outcome, 'completed');
        assert.equal(f.events.filter(e => e === 'turn_completed').length, 1);
        assert.equal(f.events.includes('turn_aborted'), false);
        assert.equal(await send('second'), true);
        assert.deepEqual(f.requests[1].body.history, [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: text }]);
        assert.ok(f.requests.every(r => r.url.endsWith('/chat') && r.body.streamSpeech === false));
        assert.equal(f.plays.length, 0);
        assert.deepEqual(f.captureEvents, []);
        const late = deferred<Response>();
        f.setChat(() => late.promise);
        const pending = send('late');
        await flush();
        assert.equal(f.runtime.getSnapshot().isSubtitleVisible, false);
        f.runtime.resetConversation();
        late.resolve(streaming ? streamingResponse() : Response.json(response));
        assert.equal(await pending, false);
        assert.equal(f.runtime.getSnapshot().reply, '');
        assert.equal(f.runtime.getSnapshot().isSubtitleVisible, false);
        f.setChat(async () => Response.json(response));
        await send('after-reset');
        assert.deepEqual(f.requests.at(-1)?.body.history, []);
      });
    }
  }
}

test('unmuting a pending text turn keeps it silent and enables audio on the next turn', async () => {
  const f = fixture({ isMuted: true, isExhibitionMode: true });
  const chat = deferred<Response>();
  f.setChat(() => chat.promise);
  const pending = f.send('text');
  await flush();
  f.updateOptions({ isMuted: false });
  chat.resolve(streamingResponse());
  assert.equal(await pending, true);
  assert.equal(f.plays.length, 0);
  assert.equal(f.requests.length, 1);
  assert.equal(f.results.at(-1)?.outcome, 'completed');
  assert.equal(f.runtime.getSnapshot().isSubtitleVisible, true);
  f.setChat(async () => Response.json(response));
  const next = f.send('audible');
  await flush();
  assert.equal(f.plays.length, 1);
  assert.equal(f.requests[1].body.streamSpeech, true);
  f.plays[0].pending.resolve(result);
  assert.equal(await next, true);
});

test('streaming failure retains only completed units and reports partial spoken text', async () => {
  const f = fixture(); f.setChat(async () => streamingResponse());
  const pending = f.send('stream'); await flush();
  assert.equal(f.plays.length, 1);
  f.plays[0].callbacks?.onAudioComplete?.(1);
  f.plays[0].pending.resolve(result); await flush();
  assert.equal(f.plays.length, 2);
  f.plays[1].pending.reject(new Error('second audio failed'));
  assert.equal(await pending, false);
  assert.equal(f.results.at(-1)?.outcome, 'failed');
  assert.equal(f.results.at(-1)?.spokenText, '前半。');
  assert.deepEqual(f.captureEvents, ['hold', 'release']);
  f.setChat(async () => Response.json(response));
  const next = f.send('next'); await flush();
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/chat'))[1].body.history, [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: '前半。' }]);
  f.plays[2].pending.resolve(result); await next;
});

test('streaming success commits each unit once and retains the full delivered reply', async () => {
  const f = fixture(); f.setChat(async () => streamingResponse());
  const pending = f.send('stream'); await flush();
  assert.deepEqual(f.captureEvents, ['hold']);
  f.plays[0].callbacks?.onAudioComplete?.(1); f.plays[0].pending.resolve(result); await flush();
  assert.deepEqual(f.captureEvents, ['hold']);
  f.plays[1].callbacks?.onAudioComplete?.(2); f.plays[1].pending.resolve(result);
  assert.equal(await pending, true);
  assert.deepEqual(f.captureEvents, ['hold', 'release']);
  assert.equal(f.results.at(-1)?.spokenText, '前半。後半。');
});

test('delayed streaming TTS after disposal never starts playback', async () => {
  const f = fixture(); const tts = deferred<Response>();
  f.setChat(async () => streamingResponse()); f.setTts(() => tts.promise);
  const pending = f.send('old'); await flush(); f.runtime.dispose();
  tts.resolve(new Response(new Uint8Array([1]), { headers: { 'content-type': 'audio/wav' } }));
  await pending;
  assert.equal(f.plays.length, 0);
  assert.ok(f.requests.every(r => r.signal?.aborted));
});

test('audio completion remains in history when interrupted during the motion hold', async () => {
  const f = fixture(); const pending = f.send('first'); await flush();
  f.plays[0].callbacks?.onAudioComplete?.(2);
  f.runtime.interruptCurrentTurn();
  f.plays[0].pending.resolve(null); await pending;
  const next = f.send('next'); await flush();
  assert.deepEqual(f.requests.filter(r => r.url.endsWith('/chat'))[1].body.history, [{ role: 'user', content: 'こんにちは' }, { role: 'assistant', content: response.text }]);
  f.plays[1].pending.resolve(result); await next;
});

test('old voice failure cannot release the next voice turn floor', async () => {
  const f = fixture();
  const old = f.runtime.sendVoice('最初', cards, () => {}, plan('old'));
  await flush();
  const next = f.runtime.sendVoice('次', cards, () => {}, plan('next'));
  await flush();
  const before = f.timeline.filter(event => event.kind === 'floor_released').length;
  f.plays[0].pending.reject(new Error('late voice failure')); await old;
  assert.equal(f.timeline.filter(event => event.kind === 'floor_released').length, before);
  f.plays[1].pending.resolve(result); await next;
  assert.equal(f.runtime.getSnapshot().status, 'idle');
});

test('autonomous history and self context contain only delivered speech', async () => {
  const state = observeAutonomyEvidence(createInitialAutonomyState(), {
    id: 'evidence', kind: 'conversation_input', at: 1, semanticKey: 'topic',
    reasonProposals: [{ kind: 'conversation_continuation', content: '話の続き', semanticKey: 'topic', salience: 0.7 }],
  });
  const candidate = selectAutonomyCandidate(state, { enabled: true, busy: false, floorAvailable: true, attentionAvailable: true, interactionAvailable: true });
  assert.ok(candidate);
  const f = fixture();
  f.setChat(async () => Response.json({ ...response, externalAction: 'speak', usedReasonIds: [candidate.reasons[0].id] }));
  const pending = f.runtime.sendAutonomous(cards, INITIAL_AUTONOMOUS_CONTEXT, () => {}, plan('auto'), undefined, candidate);
  await flush(); assert.equal(f.plays.length, 1);
  f.plays[0].callbacks?.onAudioComplete?.(2); f.plays[0].pending.resolve(result); await pending;
  const next = f.runtime.sendAutonomous(cards, INITIAL_AUTONOMOUS_CONTEXT, () => {}, plan('auto-next'), undefined, candidate);
  await flush();
  const body = f.requests.filter(r => r.url.endsWith('/chat'))[1].body;
  assert.deepEqual(body.history, [{ role: 'assistant', content: response.text }]);
  assert.equal(body.lastSelfUtterance, response.text);
  f.plays[1].pending.resolve(result); await next;
});
