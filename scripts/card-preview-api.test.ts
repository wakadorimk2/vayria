import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAutonomousDirectorInstruction,
  buildCharacterIdentitySystemPrompt,
  buildCharacterIdentityDynamicPrompt,
  buildCharacterIdentityStaticPrompt,
  buildCardPreviewSystemPrompt,
  buildCardPreviewStaticPrompt,
  buildConversationActionPolicyStaticPrompt,
  buildProgramContextSystemPrompt,
  buildProgramContextDynamicPrompt,
  buildProgramContextStaticPrompt,
  buildUtterancePlanInstruction,
  buildUsedReasonIdsProperty,
  buildVoiceInteractionPolicySystemPrompt,
  createInteractionReactionResponse,
  isActionCommitmentMessage,
  isContentBearingVoiceMessage,
  isDirectActionRequestMessage,
  isMetaOnlyActionResponse,
  isRetryableIncompleteResponseError,
  maxOutputTokensForChatMode,
  normalizeVoiceInteractionDecision,
  parseAutonomousAssistantResponse,
  parseCardPreviewResponse,
  parseConversationActionPolicy,
  parseVoiceAssistantResponse,
  readPerformerStateContext,
  readCardPreviewRequest,
  readConversationEvent,
  readAutonomyCandidate,
  resolveProvisionalActivatedCards,
  VOICE_REPLY_INSTRUCTION,
} from '../server/localApi.js';
import { OpenAiResponsesError } from '../server/openAiResponses.js';
import {
  DEFAULT_PROGRAM_CONTEXT,
  isProgramContext,
} from '../src/conversation/programContext.js';

const VALID_CONTEXT = {
  callbackTendency: 0.25,
  fragmentation: 0.1,
  semanticBiases: ['鶏に関係する具体物を一つ連想する'],
};

const VALID_PERFORMER_STATE = {
  phase: 'scheduled',
  energy: 0.42,
  emotion: 'sorrow',
  emotionActivation: 0.4,
  attentionTarget: 'viewer',
  attentionStrength: 0.8,
} as const;

const AUTONOMY_CANDIDATE = {
  episodeId: 'episode-1',
  decisionEvidenceIds: ['evidence-1'],
  reasons: [
    {
      id: 'reason-1',
      episodeId: 'episode-1',
      parentReasonId: null,
      kind: 'conversation_continuation',
      content: '雨の話を続ける理由',
      semanticKey: 'topic:rain',
      salience: 0.8,
      status: 'active',
      deferCause: null,
      wakeOn: [],
      decisionEvidenceIds: ['evidence-1'],
      createdAt: 1,
      updatedAt: 1,
      lastEvaluatedEvidenceId: null,
      mergedIntoReasonId: null,
    },
  ],
} as const;

test('chat reserves output space for nano reasoning and structured output', () => {
  assert.equal(maxOutputTokensForChatMode('voice'), 2_048);
  assert.equal(maxOutputTokensForChatMode('voice', 'output_limit'), 4_096);
  assert.equal(maxOutputTokensForChatMode('voice', 'contract'), 2_048);
  assert.equal(maxOutputTokensForChatMode('manual'), 2_048);
  assert.equal(maxOutputTokensForChatMode('manual', 'output_limit'), 2_048);
  assert.equal(maxOutputTokensForChatMode('autonomous'), 2_048);
  assert.equal(maxOutputTokensForChatMode('autonomous', 'output_limit'), 2_048);
});

test('only output-limit incomplete responses retry before speech commit', () => {
  assert.equal(
    isRetryableIncompleteResponseError(
      new OpenAiResponsesError('incomplete', {
        kind: 'incomplete',
        incompleteReason: 'max_output_tokens',
      }),
    ),
    true,
  );
  assert.equal(
    isRetryableIncompleteResponseError(
      new OpenAiResponsesError('filtered', {
        kind: 'incomplete',
        incompleteReason: 'content_filter',
      }),
    ),
    false,
  );
  assert.equal(
    isRetryableIncompleteResponseError(
      new OpenAiResponsesError('provider', { kind: 'provider' }),
    ),
    false,
  );
});

test('autonomous used reason schema permits only offered reason IDs', () => {
  assert.deepEqual(
    buildUsedReasonIdsProperty(['reason-1', 'reason-2']),
    {
      type: 'array',
      items: {
        type: 'string',
        enum: ['reason-1', 'reason-2'],
      },
      maxItems: 2,
    },
  );
  assert.deepEqual(buildUsedReasonIdsProperty([]), {
    type: 'array',
    items: {
      type: 'string',
      enum: [],
    },
    maxItems: 0,
  });
});

test('provisional card metadata keeps speaking turns valid', () => {
  const cards = ['rain', 'sleepy'];
  assert.deepEqual(
    resolveProvisionalActivatedCards(
      'voice',
      { voiceAction: 'take_floor' },
      cards,
      null,
    ),
    ['rain'],
  );
  assert.deepEqual(
    resolveProvisionalActivatedCards(
      'autonomous',
      { externalAction: 'speak' },
      cards,
      'sleepy',
    ),
    ['sleepy'],
  );
  assert.deepEqual(
    resolveProvisionalActivatedCards(
      'voice',
      { voiceAction: 'listen' },
      cards,
      'sleepy',
    ),
    [],
  );
  assert.deepEqual(
    resolveProvisionalActivatedCards(
      'autonomous',
      { externalAction: 'none' },
      cards,
      'sleepy',
    ),
    [],
  );
});

const AUTONOMY_CANDIDATE_WIRE = {
  episodeId: AUTONOMY_CANDIDATE.episodeId,
  decisionEvidenceIds: AUTONOMY_CANDIDATE.decisionEvidenceIds,
  reasons: [
    {
      id: AUTONOMY_CANDIDATE.reasons[0].id,
      episodeId: AUTONOMY_CANDIDATE.reasons[0].episodeId,
      parentReasonId: AUTONOMY_CANDIDATE.reasons[0].parentReasonId,
      kind: AUTONOMY_CANDIDATE.reasons[0].kind,
      content: AUTONOMY_CANDIDATE.reasons[0].content,
      semanticKey: AUTONOMY_CANDIDATE.reasons[0].semanticKey,
      salience: AUTONOMY_CANDIDATE.reasons[0].salience,
      status: AUTONOMY_CANDIDATE.reasons[0].status,
      deferCause: AUTONOMY_CANDIDATE.reasons[0].deferCause,
      wakeOn: AUTONOMY_CANDIDATE.reasons[0].wakeOn,
      decisionEvidenceIds: AUTONOMY_CANDIDATE.reasons[0].decisionEvidenceIds,
    },
  ],
} as const;

test('autonomy candidate uses the decision evidence contract only', () => {
  const parsed = readAutonomyCandidate(AUTONOMY_CANDIDATE_WIRE);
  assert.deepEqual(parsed.decisionEvidenceIds, ['evidence-1']);
  assert.deepEqual(parsed.reasons[0].decisionEvidenceIds, ['evidence-1']);

  assert.throws(
    () =>
      readAutonomyCandidate({
        ...AUTONOMY_CANDIDATE_WIRE,
        decisionEvidenceIds: Array.from({ length: 25 }, (_, index) => `e-${index}`),
      }),
    /decisionEvidenceIds format is invalid/,
  );
  assert.throws(
    () =>
      readAutonomyCandidate({
        ...AUTONOMY_CANDIDATE_WIRE,
        reasons: [
          {
            ...AUTONOMY_CANDIDATE_WIRE.reasons[0],
            decisionEvidenceIds: ['not-offered'],
          },
        ],
      }),
    /decisionEvidenceIds must be offered evidence/,
  );
  assert.throws(
    () =>
      readAutonomyCandidate({
        ...AUTONOMY_CANDIDATE_WIRE,
        evidenceHistory: [],
      }),
    /unsupported field/,
  );
  assert.throws(
    () =>
      readAutonomyCandidate({
        episodeId: 'episode-1',
        evidenceIds: ['evidence-1'],
        reasons: [
          {
            ...AUTONOMY_CANDIDATE_WIRE.reasons[0],
            evidenceIds: ['evidence-1'],
          },
        ],
      }),
    /unsupported field/,
  );
});

test('performer state context validates the bounded self-state contract', () => {
  assert.deepEqual(
    readPerformerStateContext(VALID_PERFORMER_STATE),
    VALID_PERFORMER_STATE,
  );
  assert.equal(readPerformerStateContext(undefined), null);
  assert.throws(
    () =>
      readPerformerStateContext({
        ...VALID_PERFORMER_STATE,
        energy: 1.1,
      }),
    /performerState format is invalid/,
  );
  assert.throws(
    () =>
      readPerformerStateContext({
        ...VALID_PERFORMER_STATE,
        internalNote: '不要受け付ける',
      }),
    /unsupported field/,
  );
});

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

test('cache prefixes exclude turn-specific identity, cards, and runtime values', () => {
  const policyPrefix = buildConversationActionPolicyStaticPrompt();
  const previewPrefix = buildCardPreviewStaticPrompt();
  const identityPrefix = buildCharacterIdentityStaticPrompt();
  const programPrefix = buildProgramContextStaticPrompt();
  assert.doesNotMatch(policyPrefix, /character-identity|forced card is|0\.25/u);
  assert.doesNotMatch(previewPrefix, /Selected card|Callback tendency|0\.25/u);
  assert.doesNotMatch(identityPrefix, /ベイリア、聞こえる|"role":"direct_address"/u);
  assert.doesNotMatch(programPrefix, /before_card_change|after_card_change/u);
  assert.match(identityPrefix, /The character is Vayria/u);
  assert.match(programPrefix, /behavior context, not spoken content/u);
});

test('dynamic prompt sections retain turn-specific identity and program values', () => {
  const identity = buildCharacterIdentityDynamicPrompt(
    'ベイリア、聞こえる？',
    {
      version: 1,
      canonicalName: 'Vayria',
      displayName: 'ヴェイリア',
      aliases: [],
    },
  );
  const program = buildProgramContextDynamicPrompt({
    ...DEFAULT_PROGRAM_CONTEXT,
    phase: 'after_card_change',
  });
  assert.match(identity, /"role":"direct_address"/u);
  assert.match(program, /A card change has occurred/u);
});

test('voice prompt includes identity and program context once', () => {
  const prompt = buildVoiceInteractionPolicySystemPrompt(
    'concept-chicken',
    VALID_CONTEXT,
  );
  assert.equal(prompt.match(/<character-identity>/gu)?.length, 1);
  assert.equal(prompt.match(/<program-context>/gu)?.length, 1);
});

test('program context keeps the card segment viewer-directed', () => {
  const prompt = buildProgramContextSystemPrompt();

  assert.equal(DEFAULT_PROGRAM_CONTEXT.phase, 'before_card_change');
  assert.equal(isProgramContext(DEFAULT_PROGRAM_CONTEXT), true);
  assert.match(prompt, /live card-impression segment/);
  assert.match(prompt, /before the viewer has changed a card/);
  assert.match(prompt, /Do not imply that a card has changed/);
  assert.match(prompt, /viewer decides when to choose or change a card/);
  assert.match(
    prompt,
    /must not pressure the viewer or invent that a card was changed/,
  );
  assert.match(prompt, /impression changes before and after a card change/);
  assert.match(prompt, /behavior context, not spoken content/);
});

test('program context changes its card phase instruction after a swap', () => {
  const prompt = buildProgramContextSystemPrompt({
    ...DEFAULT_PROGRAM_CONTEXT,
    phase: 'after_card_change',
  });

  assert.match(prompt, /A card change has occurred in this segment/);
  assert.match(prompt, /Notice its impression when relevant/);
  assert.match(prompt, /do not claim that another change happened/);
});

test('autonomous director prompt prioritizes the latest viewer intent', () => {
  const prompt = buildAutonomousDirectorInstruction(
    '朝ごはん',
    3,
    'question',
    0,
    'available',
    {
      phase: 'scheduled',
      energy: 0.42,
      emotion: 'sorrow',
      emotionActivation: 0.4,
      attentionTarget: 'viewer',
      attentionStrength: 0.8,
    },
    undefined,
    '青い光が気になるな',
  );

  assert.match(prompt, /Latest viewer intent: question/);
  assert.match(prompt, /Autonomous turns since latest viewer input: 0/);
  assert.match(prompt, /Viewer engagement: available/);
  assert.match(prompt, /live card-impression segment/);
  assert.match(prompt, /viewer decides when to choose or change a card/);
  assert.match(prompt, /Self energy: 0\.42/);
  assert.match(prompt, /Self attention target: viewer/);
  assert.match(prompt, /latest completed Vayria spoken line is output data/);
  assert.match(prompt, /<last-self-utterance>/);
  assert.match(prompt, /青い光が気になるな/);
  assert.match(prompt, /Do not quote or mechanically paraphrase it/);
  assert.match(
    prompt,
    /latest viewer intent and recent conversation history as the current situation/,
  );
  assert.match(prompt, /give that latest viewer turn priority/);
  assert.match(prompt, /backchannel or unfinished, do not force a new topic/);
  assert.match(prompt, /externalAction for this offered candidate: speak or none/);
  assert.doesNotMatch(prompt, /silence means/);
  assert.match(prompt, /Use the self state as quiet background context/);
});

test('autonomous response contract separates outward action from internal delta', () => {
  assert.deepEqual(
    parseAutonomousAssistantResponse(
      JSON.stringify({
        externalAction: 'speak',
        text: '雨の音が近いですわ',
        emotion: 'neutral',
        activatedCards: ['rain'],
        speechAct: 'react',
        expressionLevel: 'low',
        usedReasonIds: ['reason-1'],
        internalDelta: { reasonUpdates: [] },
      }),
      AUTONOMY_CANDIDATE,
      ['rain'],
      null,
    ),
    {
      externalAction: 'speak',
      text: '雨の音が近いですわ',
      emotion: 'neutral',
      activatedCards: ['rain'],
      speechAct: 'react',
      expressionLevel: 'low',
      usedReasonIds: ['reason-1'],
      internalDelta: { reasonUpdates: [] },
    },
  );

  const none = parseAutonomousAssistantResponse(
    JSON.stringify({
      externalAction: 'none',
      text: '',
      emotion: 'joy',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
      usedReasonIds: [],
      internalDelta: {
        reasonUpdates: [
          {
            operation: 'defer',
            reasonId: 'reason-1',
            cause: 'floor_unavailable',
            wakeOn: ['floor_available'],
          },
        ],
      },
    }),
    AUTONOMY_CANDIDATE,
    [],
    null,
  );
  assert.equal(none.externalAction, 'none');
  assert.equal(none.text, '');
  assert.equal(none.internalDelta?.reasonUpdates.length, 1);

  const strictNullableUpdate = parseAutonomousAssistantResponse(
    JSON.stringify({
      externalAction: 'none',
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
      usedReasonIds: [],
      internalDelta: {
        reasonUpdates: [
          {
            operation: 'resolve',
            kind: null,
            content: null,
            semanticKey: null,
            salience: null,
            reasonId: 'reason-1',
            parentReasonId: null,
            salienceDelta: null,
            cause: null,
            wakeOn: null,
            targetReasonId: null,
          },
        ],
      },
    }),
    AUTONOMY_CANDIDATE,
    [],
    null,
  );
  assert.deepEqual(strictNullableUpdate.internalDelta?.reasonUpdates, [
    { operation: 'resolve', reasonId: 'reason-1' },
  ]);

  const noisyCreate = parseAutonomousAssistantResponse(
    JSON.stringify({
      externalAction: 'none',
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
      usedReasonIds: [],
      internalDelta: {
        reasonUpdates: [
          {
            operation: 'create',
            kind: 'new_association',
            content: '新しい連想',
            semanticKey: 'association:new',
            salience: 0.5,
            reasonId: 'unused-reason-id',
            parentReasonId: null,
            salienceDelta: 0.2,
            cause: 'floor_unavailable',
            wakeOn: ['floor_available'],
            targetReasonId: 'unused-target-id',
          },
        ],
      },
    }),
    AUTONOMY_CANDIDATE,
    [],
    null,
  );
  assert.deepEqual(noisyCreate.internalDelta?.reasonUpdates, [
    {
      operation: 'create',
      kind: 'new_association',
      content: '新しい連想',
      semanticKey: 'association:new',
      salience: 0.5,
      parentReasonId: null,
    },
  ]);

  assert.throws(
    () =>
      parseAutonomousAssistantResponse(
        JSON.stringify({
          externalAction: 'speak',
          text: '不正な理由ですわ',
          emotion: 'neutral',
          activatedCards: [],
          usedReasonIds: ['unknown-reason'],
          internalDelta: { reasonUpdates: [] },
        }),
        AUTONOMY_CANDIDATE,
        [],
        null,
      ),
    /offered candidate reasons/,
  );
});

test('autonomous reason updates reject unknown, duplicate, and oversized mutations', () => {
  const response = (internalDelta: unknown) =>
    parseAutonomousAssistantResponse(
      JSON.stringify({
        externalAction: 'none',
        text: '',
        emotion: 'neutral',
        activatedCards: [],
        speechAct: null,
        expressionLevel: null,
        usedReasonIds: [],
        internalDelta,
      }),
      AUTONOMY_CANDIDATE,
      [],
      null,
    );

  assert.throws(
    () =>
      response({
        reasonUpdates: [
          { operation: 'resolve', reasonId: 'unknown-reason' },
        ],
      }),
    /unknown reason/,
  );
  assert.throws(
    () =>
      response({
        reasonUpdates: [
          { operation: 'resolve', reasonId: 'reason-1' },
          { operation: 'expire', reasonId: 'reason-1' },
        ],
      }),
    /must not duplicate a reason/,
  );
  assert.throws(
    () =>
      response({
        reasonUpdates: [
          {
            operation: 'resolve',
            reasonId: 'reason-1',
            unsupportedField: 'reject this',
          },
        ],
      }),
    /unsupported field/,
  );
  assert.throws(
    () =>
      response({
        reasonUpdates: [
          {
            operation: 'create',
            kind: 'new_association',
            content: 'x'.repeat(121),
            semanticKey: 'association:oversized',
            salience: 0.4,
            parentReasonId: null,
          },
        ],
      }),
    /reason content must be 120 characters or fewer/,
  );
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
        speechAct: null,
        expressionLevel: null,
      }),
      [],
      null,
      'えっと…',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
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
        speechAct: null,
        expressionLevel: null,
      }),
      [],
      null,
      'うーん',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
      voiceAction: 'backchannel',
      backchannelCue: 'uun',
    },
  );
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'react_nonverbally',
        backchannelCue: 'none',
        text: '',
        emotion: 'joy',
        activatedCards: [],
        speechAct: null,
        expressionLevel: null,
      }),
      [],
      null,
      'まあ、そんな感じ',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
      voiceAction: 'react_nonverbally',
      backchannelCue: 'none',
    },
  );
  assert.deepEqual(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'take_floor',
        backchannelCue: 'none',
        text: '雨ですね',
        emotion: 'neutral',
        activatedCards: ['rain'],
        speechAct: 'react',
        expressionLevel: 'low',
      }),
      ['rain'],
      null,
      '今日は雨だった',
    ),
    {
      text: '雨ですね',
      emotion: 'neutral',
      activatedCards: ['rain'],
      speechAct: 'react',
      expressionLevel: 'low',
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

test('provider timing events accept only safe lifecycle metadata', () => {
  const event = readConversationEvent({
    at: '2026-09-03T00:00:00.000Z',
    elapsedMs: 750,
    event: 'llm_provider_first_chunk',
    source: 'voice',
    turnId: 'turn-provider-timing-1',
    purpose: 'response-generation',
    callIndex: 1,
    retry: 0,
  });
  assert.equal(event.purpose, 'response-generation');
  assert.equal(event.callIndex, 1);
  assert.equal(event.retry, 0);
  assert.throws(
    () =>
      readConversationEvent({
        ...event,
        event: 'llm_done',
      }),
    /only valid for provider timing events/,
  );
  assert.throws(
    () =>
      readConversationEvent({
        ...event,
        prompt: 'must not be logged',
      }),
    /unsupported field/,
  );
});

test('unit TTS events accept only a bounded unit index', () => {
  const event = readConversationEvent({
    at: '2026-09-03T00:00:00.000Z',
    elapsedMs: 1_000,
    event: 'tts_unit_playback_started',
    source: 'voice',
    turnId: 'turn-unit-1',
    unitIndex: 1,
  });
  assert.equal(event.unitIndex, 1);
  assert.throws(
    () => readConversationEvent({ ...event, unitIndex: 2 }),
    /unitIndex must be 0 or 1/,
  );
  assert.throws(
    () => readConversationEvent({ ...event, event: 'tts_start' }),
    /only valid for unit TTS events/,
  );
});

test('playback gesture telemetry accepts only safe reason classifications', () => {
  const event = readConversationEvent({
    at: '2026-09-02T00:00:00.000Z',
    elapsedMs: 1_000,
    event: 'playback_gesture_required',
    source: 'voice',
    turnId: 'turn-gesture-1',
    phase: 'tts',
    reason: 'start_timeout',
  });
  assert.equal(event.reason, 'start_timeout');

  assert.throws(
    () =>
      readConversationEvent({
        at: '2026-09-02T00:00:00.000Z',
        elapsedMs: 1_000,
        event: 'playback_gesture_required',
        source: 'voice',
        turnId: 'turn-gesture-2',
        reason: 'private browser error detail',
      }),
    /playback gesture reason is invalid/,
  );
});

test('playback startup telemetry accepts only bounded allowlisted diagnostics', () => {
  const event = readConversationEvent({
    at: '2026-09-03T00:00:00.000Z',
    elapsedMs: 1_000,
    event: 'playback_startup',
    source: 'voice',
    turnId: 'turn-playback-startup-1',
    phase: 'tts',
    playbackRoute: 'conversation',
    audioSourceKind: 'stream',
    firstChunkBytes: 4_096,
    firstChunkIntervalMs: 42,
    bufferedDurationMs: 168,
    primingOutcome: 'target',
    primingTargetMs: 150,
    primingWaitMs: 42,
    audioContextState: 'running',
    sampleRateHz: 48_000,
  });
  assert.equal(event.primingTargetMs, 150);
  assert.equal(event.audioContextState, 'running');

  assert.throws(
    () =>
      readConversationEvent({
        ...event,
        content: 'must not be logged',
      }),
    /unsupported field/,
  );
  assert.throws(
    () =>
      readConversationEvent({
        ...event,
        sampleRateHz: -1,
      }),
    /sampleRateHz must be a non-negative integer/,
  );
  assert.throws(
    () =>
      readConversationEvent({
        ...event,
        event: 'playback_started',
      }),
    /only valid for playback_startup/,
  );
});

test('autonomy gate events keep only bounded diagnostic fields', () => {
  const event = readConversationEvent({
    at: '2026-08-23T00:00:00.000Z',
    elapsedMs: 0,
    event: 'autonomy_gate',
    source: 'autonomous',
    turnId: 'autonomy-gate-1',
    gateEvent: 'turn_completed',
    gatePhase: 'refractory',
    transition: 'entered_refractory',
    candidateReasonIds: ['reason-1'],
    candidateEvidenceIds: ['evidence-1'],
    usedReasonIds: ['reason-1'],
    createdReasonIds: ['reason-2'],
    resolvedReasonIds: ['reason-1'],
    internalDeltaOperations: ['create', 'resolve'],
    externalAction: 'speak',
    nextEligibleAt: 18_000,
    delayMs: 8_000,
  });
  assert.deepEqual(event.usedReasonIds, ['reason-1']);
  assert.deepEqual(event.createdReasonIds, ['reason-2']);
  assert.deepEqual(event.resolvedReasonIds, ['reason-1']);
  assert.deepEqual(event.internalDeltaOperations, ['create', 'resolve']);
  assert.equal(event.externalAction, 'speak');
  assert.throws(
    () =>
      readConversationEvent({
        at: '2026-08-23T00:00:00.000Z',
        elapsedMs: 0,
        event: 'autonomy_gate',
        source: 'autonomous',
        turnId: 'autonomy-gate-1',
        gateEvent: 'turn_completed',
        gatePhase: 'refractory',
        content: 'must not be logged',
      }),
    /unsupported field/,
  );
  assert.throws(
    () =>
      readConversationEvent({
        at: '2026-08-23T00:00:00.000Z',
        elapsedMs: 0,
        event: 'autonomy_gate',
        source: 'autonomous',
        turnId: 'autonomy-gate-1',
        gateEvent: 'not-valid',
        gatePhase: 'refractory',
      }),
    /gateEvent is invalid/,
  );
});

test('voice policy prompt prioritizes content-bearing utterances', () => {
  const prompt = buildVoiceInteractionPolicySystemPrompt(
    null,
    VALID_CONTEXT,
  );

  assert.match(prompt, /question, request, concrete fact, feeling, preference, experience/);
  assert.match(prompt, /direct participation call such as ねえ or ちょっと/);
  assert.match(prompt, /without producing a spoken echo/);
  assert.match(prompt, /small existing reaction is clearly sufficient/);
  assert.match(prompt, /live card-impression segment/);
  assert.match(prompt, /Do not use listen or backchannel for a content-bearing utterance/);
  assert.match(prompt, /clearly unfinished fragment/);
  assert.match(prompt, /react_nonverbally/);
  assert.match(prompt, /wait is reserved for autonomous scheduling/);
});

test('identity context resolves direct calls and self-reference as Vayria', () => {
  const prompt = buildCharacterIdentitySystemPrompt(
    'ベイリア、聞こえる？',
    {
      version: 1,
      canonicalName: 'Vayria',
      displayName: 'ヴェイリア',
      aliases: [],
    },
  );

  assert.match(prompt, /"role":"direct_address"/);
  assert.match(prompt, /The character is Vayria, displayed as ヴェイリア/);
  assert.match(prompt, /Do not treat the resolved name as the viewer name/);
  assert.match(prompt, /Keep the raw user message and conversation history unchanged/);
});

test('identity context confirms only an explicitly stored alias', () => {
  const prompt = buildCharacterIdentitySystemPrompt(
    'ベイリアとも呼んで',
    {
      version: 1,
      canonicalName: 'Vayria',
      displayName: 'ヴェイリア',
      aliases: ['ベイリア'],
    },
  );

  assert.match(prompt, /"stored":true/);
});

test('voice content classifier separates topics from phatic and unfinished speech', () => {
  assert.equal(isContentBearingVoiceMessage('今日は雨だった'), true);
  assert.equal(isContentBearingVoiceMessage('それどう思う？'), true);
  assert.equal(isContentBearingVoiceMessage('えっと…'), false);
  assert.equal(isContentBearingVoiceMessage('うん'), false);
  assert.equal(isContentBearingVoiceMessage('あー'), false);
  assert.equal(isContentBearingVoiceMessage('まあ、そんな感じ'), false);
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
    { action: 'silence', backchannelCue: 'none' },
  );
  assert.deepEqual(
    normalizeVoiceInteractionDecision('ねえ', {
      action: 'listen',
      backchannelCue: 'none',
    }),
    { action: 'take_floor', backchannelCue: 'none' },
  );
  assert.deepEqual(
    normalizeVoiceInteractionDecision('ベイリア', {
      action: 'listen',
      backchannelCue: 'none',
    }),
    { action: 'take_floor', backchannelCue: 'none' },
  );
  assert.deepEqual(
    normalizeVoiceInteractionDecision('プロジェクトVayriaX', {
      action: 'listen',
      backchannelCue: 'none',
    }),
    { action: 'listen', backchannelCue: 'none' },
  );
  assert.deepEqual(
    normalizeVoiceInteractionDecision('まあ、そんな感じ', {
      action: 'take_floor',
      backchannelCue: 'none',
    }),
    { action: 'react_nonverbally', backchannelCue: 'none' },
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
  assert.match(VOICE_REPLY_INSTRUCTION, /do not treat the announcement or agreement as progress/);
  assert.match(VOICE_REPLY_INSTRUCTION, /directly asks you to perform an action/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Do not claim to have seen, checked, changed, or completed an external-world action/);
  assert.match(VOICE_REPLY_INSTRUCTION, /perform the first small step now/);
  assert.match(VOICE_REPLY_INSTRUCTION, /ask one concrete question that names the missing item/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Do not invent meeting-style purpose, agenda, decisions, owners, or schedules/);
  assert.match(VOICE_REPLY_INSTRUCTION, /Do not force a question or a new topic/);
});

test('utterance plan separates action from wording and suppresses poetry', () => {
  const low = buildUtterancePlanInstruction('low');
  assert.match(low, /two stages within this single response/);
  assert.match(low, /choose speechAct/);
  assert.match(low, /expression budget is low/);
  assert.match(low, /Avoid poetic scene-setting/);
  assert.match(low, /one card-derived association/);
  assert.match(low, /plain concrete streamer reaction is normal/);
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
        speechAct: null,
        expressionLevel: null,
      }),
      [],
      null,
      'えっと…',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
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
      speechAct: null,
      expressionLevel: null,
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
        speechAct: null,
        expressionLevel: null,
      }),
      [],
      null,
      'うん',
    ),
    {
      text: '',
      emotion: 'neutral',
      activatedCards: [],
      speechAct: null,
      expressionLevel: null,
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
      speechAct: null,
      expressionLevel: null,
      interactionAction: 'backchannel',
      backchannelCue: 'un',
    },
  );
});

test('content-bearing take_floor responses cannot be generic backchannels', () => {
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'take_floor',
          backchannelCue: 'none',
          text: 'うん',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '今日は雨だった',
      ),
    /must contain a concrete reaction/,
  );
  assert.equal(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'take_floor',
        backchannelCue: 'none',
        text: 'うん',
        emotion: 'neutral',
        activatedCards: ['rain'],
        speechAct: 'agree',
        expressionLevel: 'low',
      }),
      ['rain'],
      null,
      'それ、好き？',
    ).text,
    'うん',
  );
});

test('action commitments must move to concrete content', () => {
  assert.equal(isActionCommitmentMessage('目的と決定事項を整理します'), true);
  assert.equal(isActionCommitmentMessage('まずアジェンダ案を作成しましょう'), true);
  assert.equal(
    isActionCommitmentMessage('了解...まずアジェンダ案を作成しましょう。'),
    true,
  );
  assert.equal(isActionCommitmentMessage('今日は雨だった'), false);
  assert.equal(isDirectActionRequestMessage('自己紹介して'), true);
  assert.equal(isDirectActionRequestMessage('目的を言って'), true);
  assert.equal(isDirectActionRequestMessage('一つ挙げてください'), true);
  assert.equal(isDirectActionRequestMessage('次の項目へ進んで'), true);
  assert.equal(isDirectActionRequestMessage('今日は雨だった'), false);
  assert.equal(isMetaOnlyActionResponse('ええ、その方向で進めましょう'), true);
  assert.equal(isMetaOnlyActionResponse('お願いします'), true);
  assert.equal(
    isMetaOnlyActionResponse('了解...まずアジェンダ案を作成しましょう。'),
    true,
  );
  assert.equal(isMetaOnlyActionResponse('目的は会議の成功です'), false);
  assert.equal(isMetaOnlyActionResponse('目的は会議の成功です。整理します'), false);
  assert.equal(isMetaOnlyActionResponse('何を目的にしますか？'), false);
  assert.equal(isActionCommitmentMessage('何を目的に整理しましょうか'), false);

  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'take_floor',
          backchannelCue: 'none',
          text: 'ええ、その方向で進めましょう',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '目的と決定事項を整理します',
      ),
    /Action commitments must lead to concrete content/,
  );
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'take_floor',
          backchannelCue: 'none',
          text: 'はい、自己紹介します',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '自己紹介して',
      ),
    /Action commitments must lead to concrete content/,
  );
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'react_nonverbally',
          backchannelCue: 'none',
          text: '',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '自己紹介して',
      ),
    /Content-bearing voice responses must use take_floor/,
  );
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'react_nonverbally',
          backchannelCue: 'none',
          text: '',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '今どういう意味？',
      ),
    /Content-bearing voice responses must use take_floor/,
  );
  assert.equal(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'take_floor',
        backchannelCue: 'none',
        text: '私はVayriaです。静かな会話を大切にします',
        emotion: 'neutral',
        activatedCards: ['rain'],
        speechAct: 'answer',
        expressionLevel: 'low',
      }),
      ['rain'],
      null,
      '自己紹介して',
    ).text,
    '私はVayriaです。静かな会話を大切にします',
  );
  assert.throws(
    () =>
      parseVoiceAssistantResponse(
        JSON.stringify({
          voiceAction: 'take_floor',
          backchannelCue: 'none',
          text: 'では',
          emotion: 'neutral',
          activatedCards: [],
        }),
        [],
        null,
        '了解...まずアジェンダ案を作成しましょう。',
      ),
    /Action commitments must lead to concrete content/,
  );
  assert.equal(
    parseVoiceAssistantResponse(
      JSON.stringify({
        voiceAction: 'take_floor',
        backchannelCue: 'none',
        text: '目的は会議の成功です',
        emotion: 'neutral',
        activatedCards: ['rain'],
        speechAct: 'answer',
        expressionLevel: 'low',
      }),
      ['rain'],
      null,
      '目的と決定事項を整理します',
    ).text,
    '目的は会議の成功です',
  );
});
