import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCardPreviewSystemPrompt,
  buildVoiceInteractionPolicySystemPrompt,
  createVoiceReactionResponse,
  isContentBearingVoiceMessage,
  normalizeVoiceInteractionDecision,
  parseCardPreviewResponse,
  parseVoiceInteractionPolicy,
  readCardPreviewRequest,
  VOICE_REPLY_INSTRUCTION,
} from '../server/localApi.js';

const VALID_CONTEXT = {
  callbackTendency: 0.25,
  fragmentation: 0.1,
  semanticBiases: ['鶏に関係する具体物を一つ連想する'],
};

test('card preview request accepts a known card and runtime context', () => {
  assert.deepEqual(
    readCardPreviewRequest({
      cardId: 'chicken',
      performanceContext: VALID_CONTEXT,
    }),
    {
      cardId: 'chicken',
      performanceContext: VALID_CONTEXT,
    },
  );
});

test('card preview request rejects unknown cards and unsupported fields', () => {
  assert.throws(
    () =>
      readCardPreviewRequest({
        cardId: 'missing-card',
        performanceContext: VALID_CONTEXT,
      }),
    /known card ID/,
  );
  assert.throws(
    () =>
      readCardPreviewRequest({
        cardId: 'chicken',
        performanceContext: VALID_CONTEXT,
        message: '不要な入力',
      }),
    /unsupported card preview field/,
  );
});

test('card preview request validates runtime context bounds', () => {
  assert.throws(
    () =>
      readCardPreviewRequest({
        cardId: 'chicken',
        performanceContext: {
          ...VALID_CONTEXT,
          callbackTendency: 1.1,
        },
      }),
    /performanceContext format is invalid/,
  );
});

test('card preview response keeps only text and normalized emotion', () => {
  assert.deepEqual(
    parseCardPreviewResponse(
      JSON.stringify({ text: '羽音が聞こえた気がする。', emotion: 'joy' }),
    ),
    { text: '羽音が聞こえた気がする。', emotion: 'joy' },
  );
  assert.deepEqual(
    parseCardPreviewResponse(
      JSON.stringify({ text: '雨の気配。', emotion: 'unsupported' }),
    ),
    { text: '雨の気配。', emotion: 'neutral' },
  );
  assert.throws(
    () => parseCardPreviewResponse('{"text":""}'),
    /invalid response text/,
  );
});

test('card preview prompt uses behavior state without motion asset details', () => {
  const prompt = buildCardPreviewSystemPrompt('chicken', VALID_CONTEXT);

  assert.match(prompt, /Behavior stance: inquisitive/);
  assert.match(prompt, /Behavior energy: medium/);
  assert.match(prompt, /Behavior engagement: cautious/);
  assert.match(prompt, /Behavior gesture intention: inspect/);
  assert.equal(prompt.includes('card-chicken'), false);
  assert.equal(prompt.includes('.vrma'), false);
});

test('voice interaction policy accepts only compatible action and cue pairs', () => {
  assert.deepEqual(
    parseVoiceInteractionPolicy(
      '{"action":"listen","backchannelCue":"none"}',
    ),
    { action: 'listen', backchannelCue: 'none' },
  );
  assert.deepEqual(
    parseVoiceInteractionPolicy(
      '{"action":"backchannel","backchannelCue":"uun"}',
    ),
    { action: 'backchannel', backchannelCue: 'uun' },
  );
  assert.deepEqual(
    parseVoiceInteractionPolicy(
      '{"action":"take_floor","backchannelCue":"none"}',
    ),
    { action: 'take_floor', backchannelCue: 'none' },
  );
  assert.throws(
    () =>
      parseVoiceInteractionPolicy(
        '{"action":"backchannel","backchannelCue":"none"}',
      ),
    /invalid action or cue/,
  );
  assert.throws(
    () =>
      parseVoiceInteractionPolicy(
        '{"action":"take_floor","backchannelCue":"un","extra":true}',
      ),
    /invalid action or cue/,
  );
});

test('voice policy prompt prioritizes content-bearing utterances', () => {
  const prompt = buildVoiceInteractionPolicySystemPrompt(
    null,
    VALID_CONTEXT,
  );

  assert.match(prompt, /question, request, concrete fact, feeling, preference, experience/);
  assert.match(prompt, /Do not use listen or backchannel for a content-bearing utterance/);
  assert.match(prompt, /clearly unfinished fragment/);
});

test('voice content classifier separates topics from phatic and unfinished speech', () => {
  assert.equal(isContentBearingVoiceMessage('今日は雨だった'), true);
  assert.equal(isContentBearingVoiceMessage('それどう思う？'), true);
  assert.equal(isContentBearingVoiceMessage('えっと…'), false);
  assert.equal(isContentBearingVoiceMessage('うん'), false);
  assert.equal(isContentBearingVoiceMessage('今日は雨だったけど…'), false);
});

test('voice policy safety net promotes content-bearing non-floor decisions', () => {
  assert.deepEqual(
    normalizeVoiceInteractionDecision('今日は雨だった', {
      action: 'backchannel',
      backchannelCue: 'un',
    }),
    { action: 'take_floor', backchannelCue: 'none' },
  );
  assert.deepEqual(
    normalizeVoiceInteractionDecision('えっと…', {
      action: 'listen',
      backchannelCue: 'none',
    }),
    { action: 'listen', backchannelCue: 'none' },
  );
  assert.deepEqual(
    normalizeVoiceInteractionDecision('うん', {
      action: 'backchannel',
      backchannelCue: 'un',
    }),
    { action: 'backchannel', backchannelCue: 'un' },
  );
});

test('voice reply prompt asks for short concrete grounding', () => {
  assert.match(VOICE_REPLY_INSTRUCTION, /8 to 24 Japanese characters/);
  assert.match(VOICE_REPLY_INSTRUCTION, /one concrete topic word, feeling, or question intent/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Answer a direct question briefly/);
  assert.match(VOICE_REPLY_INSTRUCTION, /generic acknowledgment/);
});

test('non-floor voice reactions return no spoken text or activated cards', () => {
  assert.deepEqual(
    createVoiceReactionResponse({
      action: 'listen',
      backchannelCue: 'none',
    }),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'listen',
      backchannelCue: 'none',
    },
  );
  assert.deepEqual(
    createVoiceReactionResponse({
      action: 'backchannel',
      backchannelCue: 'un',
    }),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'backchannel',
      backchannelCue: 'un',
    },
  );
});
