import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCardPreviewSystemPrompt,
  buildVoiceInteractionPolicySystemPrompt,
  createInteractionReactionResponse,
  isContentBearingVoiceMessage,
  normalizeVoiceInteractionDecision,
  parseCardPreviewResponse,
  parseConversationActionPolicy,
  parseVoiceAssistantResponse,
  readCardPreviewRequest,
  readConversationEvent,
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

test('voice assistant response accepts only compatible action and cue pairs', () => {
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'listen',
        backchannelCue: 'none',
        text: '',
        emotion: 'neutral',
        activatedCards: [],
      }),
      [],
      null,
      'えっと…',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'listen',
      backchannelCue: 'none',
    },
  );
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'backchannel',
        backchannelCue: 'uun',
        text: '',
        emotion: 'neutral',
        activatedCards: [],
      }),
      [],
      null,
      'うーん',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'backchannel',
      backchannelCue: 'uun',
    },
  );
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'take_floor',
        backchannelCue: 'none',
        text: '雨ですね',
        emotion: 'neutral',
        activatedCards: [],
      }),
      [],
      null,
      '今日は雨だった',
    ),
    {
      text: '雨ですね',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'take_floor',
      backchannelCue: 'none',
    },
  );
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'backchannel',
          backchannelCue: 'none',
          text: '',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        'うん',
      ),
    /action and backchannel cue are incompatible/,
  );
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'take_floor',
          backchannelCue: 'un',
          text: '雨ですね',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '今日は雨だった',
      ),
    /action and backchannel cue are incompatible/,
  );
});

test('common conversation policy accepts non-speech actions and rejects wait', () => {
  assert.deepEqual(
    parseConversationActionPolicy(
      '{"action":"react_nonverbally","backchannelCue":"none"}',
    ),
    { action: 'react_nonverbally', backchannelCue: 'none' },
  );
  assert.deepEqual(
    parseConversationActionPolicy(
      '{"action":"silence","backchannelCue":"none"}',
    ),
    { action: 'silence', backchannelCue: 'none' },
  );
  assert.throws(
    () =>
      parseConversationActionPolicy(
        '{"action":"wait","backchannelCue":"none"}',
      ),
    /invalid action or cue/,
  );
  assert.throws(
    () =>
      parseConversationActionPolicy(
        '{"action":"react_nonverbally","backchannelCue":"un"}',
      ),
    /invalid action or cue/,
  );
});

test('conversation events validate the shared interactionAction field', () => {
  assert.equal(
    readConversationEvent({
      at: '2026-08-23T00:00:00.000Z',
      elapsedMs: 0,
      event: 'turn_completed',
      source: 'manual',
      turnId: 'turn-1',
      interactionAction: 'react_nonverbally',
    }).interactionAction,
    'react_nonverbally',
  );
  assert.throws(
    () =>
      readConversationEvent({
        at: '2026-08-23T00:00:00.000Z',
        elapsedMs: 0,
        event: 'turn_completed',
        source: 'manual',
        turnId: 'turn-1',
        interactionAction: 'unknown',
      }),
    /interactionAction is invalid/,
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
  assert.match(prompt, /react_nonverbally/);
  assert.match(prompt, /wait is reserved for autonomous scheduling/);
});

test('voice content classifier separates topics from phatic and unfinished speech', () => {
  assert.equal(isContentBearingVoiceMessage('今日は雨だった'), true);
  assert.equal(isContentBearingVoiceMessage('それどう思う？'), true);
  assert.equal(isContentBearingVoiceMessage('えっと…'), false);
  assert.equal(isContentBearingVoiceMessage('うん'), false);
  assert.equal(isContentBearingVoiceMessage('今日は雨だったけど…'), false);
});

test('common policy safety net keeps ambiguous decisions for the LLM', () => {
  assert.deepEqual(
    normalizeVoiceInteractionDecision('今日は雨だった', {
      action: 'backchannel',
      backchannelCue: 'un',
    }),
    { action: 'backchannel', backchannelCue: 'un' },
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
  assert.match(VOICE_REPLY_INSTRUCTION, /one concrete topic word, feeling, or question intent from the latest utterance and respond to it with a concrete reaction/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Use a paraphrase only when it adds a distinct reaction or clarifies the meaning/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Answer a direct question briefly/);
  assert.match(VOICE_REPLY_INSTRUCTION, /generic acknowledgment/);
  assert.match(VOICE_REPLY_INSTRUCTION, /avoid a mutual backchannel or agreement loop/);
  assert.match(VOICE_REPLY_INSTRUCTION, /do not merely mirror the latest utterance/);
  assert.match(VOICE_REPLY_INSTRUCTION, /moves slightly sideways/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Do not force a question or a new topic/);
});

test('non-floor voice responses return no spoken text or activated cards', () => {
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'listen',
        backchannelCue: 'none',
        text: '',
        emotion: 'joy',
        activatedCards: [],
      }),
      [],
      null,
      'えっと…',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'listen',
      backchannelCue: 'none',
    },
  );
  assert.deepEqual(
    createInteractionReactionResponse({
      action: 'listen',
      backchannelCue: 'none',
    }),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      interactionAction: 'listen',
      backchannelCue: 'none',
    },
  );
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'backchannel',
        backchannelCue: 'un',
        text: '',
        emotion: 'joy',
        activatedCards: [],
      }),
      [],
      null,
      'うん',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      voiceAction: 'backchannel',
      backchannelCue: 'un',
    },
  );
  assert.deepEqual(
    createInteractionReactionResponse({
      action: 'backchannel',
      backchannelCue: 'un',
    }),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      interactionAction: 'backchannel',
      backchannelCue: 'un',
    },
  );
});
