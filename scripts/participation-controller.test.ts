import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createParticipationController,
  EXHIBITION_CONVERSATION_CONTEXT,
  type ConversationContext,
  type Participant,
} from '../src/conversation/participationController.js';

test('shared microphone keeps both humans anonymous and supports a three-party exchange', () => {
  const controller = createParticipationController({ context: EXHIBITION_CONVERSATION_CONTEXT });
  const say = (text: string, at: number) => controller.evaluateFinalized({ segmentId: String(at), text, at });
  assert.equal(say('これはVayriaっていうキャラクターです', 100).decision, 'SILENT');
  const humanQuestion = say('普段ゲームとかやります？', 200);
  assert.equal(humanQuestion.mode, 'multi_party');
  assert.equal(humanQuestion.decision, 'SILENT');
  assert.equal(humanQuestion.speakerId, null);
  assert.equal(humanQuestion.participantCount, 3);
  assert.equal(say('Vayria、どう思う？', 300).decision, 'SPEAK');
  controller.observeVayriaUtterance('お二人はゲームが好き？', 400);
  assert.equal(say('うん、よく遊ぶよ', 500).category, 'follow_up_reply');
  assert.equal(say('じゃあこのカード替えてみます？', 600).decision, 'SILENT');
  assert.equal(say('Vayriaはどう思う？', 700).decision, 'SPEAK');
  assert.equal(say('Vayria', 800).decision, 'SPEAK');
  assert.equal(say('みんなはどう思う？', 900).decision, 'SPEAK');
  assert.ok(controller.getState().recentSpeakerIds.every((id) => id === null));
});

test('shared microphone reply window expires, resets, and yields to explicit overlap', () => {
  const controller = createParticipationController({ context: EXHIBITION_CONVERSATION_CONTEXT });
  controller.observeVayriaUtterance('好き？', 100);
  assert.equal(controller.evaluateFinalized({ segmentId: 'late', text: 'うん', at: 8100 }).decision, 'SILENT');
  controller.observeVayriaUtterance('好き？', 9000);
  controller.reset();
  assert.equal(controller.evaluateFinalized({ segmentId: 'reset', text: 'うん', at: 9100 }).decision, 'SILENT');
  assert.equal(controller.evaluateFinalized({ segmentId: 'overlap', text: 'Vayria、どう思う？',
    at: 9200, overlapState: 'overlap' }).decision, 'SILENT');
});
import { createInteractionTimeline } from '../src/conversation/interactionTimeline.js';

const vayria: Participant = { id: 'vayria', role: 'vayria' };
const humanA: Participant = { id: 'humanA', role: 'human' };
const humanB: Participant = { id: 'humanB', role: 'human' };

function createContext(
  participants: readonly Participant[] = [humanA, humanB, vayria],
): ConversationContext {
  return { participants };
}

function createController(
  participants: readonly Participant[] = [humanA, humanB, vayria],
) {
  return createParticipationController({
    context: createContext(participants),
  });
}

function finalize(
  controller: ReturnType<typeof createController>,
  text: string,
  speakerId: string | null,
  segmentId = `${speakerId ?? 'unknown'}-${text}`,
  at = 100,
) {
  return controller.evaluateFinalized({
    segmentId,
    text,
    speakerId,
    at,
  });
}

function observeSpeech(
  controller: ReturnType<typeof createController>,
  speakerId: string,
  segmentId: string,
  at: number,
): void {
  controller.observeSpeechStarted({ speakerId, at });
  controller.observeSpeechEnded({ speakerId, at: at + 10 });
  finalize(controller, '観測用の発話', speakerId, segmentId, at + 20);
}

test('I1 explicit address is SPEAK and targets Vayria', () => {
  const controller = createController();

  const decision = finalize(
    controller,
    'ヴェイリア、これどう思う？',
    humanA.id,
  );

  assert.equal(decision.decision, 'SPEAK');
  assert.equal(decision.mode, 'multi_party');
  assert.equal(decision.category, 'explicit_address');
  assert.equal(decision.addressivity.vayria, 1);
});

test('I2 contextual intervention is SPEAK without a Vayria name', () => {
  const controller = createController();

  const decision = finalize(controller, 'じゃあAI側の意見は？', humanA.id);

  assert.equal(decision.decision, 'SPEAK');
  assert.equal(decision.category, 'contextual_intervention');
  assert.equal(decision.addressivity.vayria, 0.85);
});

test('S1 no-reference human exchange stays SILENT', () => {
  const controller = createController();

  const first = finalize(controller, '今日ご飯どうする？', humanA.id);
  const second = finalize(
    controller,
    'ポテトでいいんじゃない？',
    humanB.id,
    'humanB-2',
    200,
  );

  assert.equal(first.decision, 'SILENT');
  assert.equal(second.decision, 'SILENT');
  assert.equal(second.category, 'no_reference');
  assert.equal(second.reason, 'human_exchange');
});

test('S2 referenced but not addressed stays SILENT', () => {
  const controller = createController();

  const first = finalize(
    controller,
    'ヴェイリアがさっきポテトって言ってたよ',
    humanA.id,
  );
  const second = finalize(
    controller,
    'じゃあそれにしようか',
    humanB.id,
    'humanB-2',
    200,
  );

  assert.equal(first.decision, 'SILENT');
  assert.equal(first.category, 'referenced_not_addressed');
  assert.equal(second.decision, 'SILENT');
});

test('a third-party Vayria mention is not a wake-word address', () => {
  const controller = createController();

  const decision = finalize(
    controller,
    'ヴェイリアがさっきの話を覚えているよ',
    humanA.id,
  );

  assert.equal(decision.decision, 'SILENT');
  assert.equal(decision.category, 'referenced_not_addressed');
});

test('a Vayria name alone is not a wake-word address', () => {
  const controller = createController();

  const decision = finalize(controller, 'ヴェイリア', humanA.id);

  assert.equal(decision.decision, 'SILENT');
  assert.equal(decision.category, 'referenced_not_addressed');
});

test('overlap is SILENT even when the text contains an address', () => {
  const controller = createController();

  controller.observeSpeechStarted({ speakerId: humanA.id, at: 100 });
  controller.observeSpeechStarted({ speakerId: humanB.id, at: 110 });
  controller.observeSpeechEnded({ speakerId: humanA.id, at: 120 });
  controller.observeSpeechEnded({ speakerId: humanB.id, at: 130 });

  const decision = finalize(
    controller,
    'ヴェイリア、ちょっと聞いて',
    humanA.id,
    'overlap-1',
    140,
  );

  assert.equal(decision.decision, 'SILENT');
  assert.equal(decision.category, 'overlap');
  assert.equal(decision.reason, 'overlap_detected');
  assert.equal(decision.floorState.kind, 'contested');
});

test('group address keeps an open floor and independent addressivity scores', () => {
  const controller = createController();

  const decision = finalize(controller, 'みんなはどう思う？', humanA.id);

  assert.equal(decision.decision, 'SILENT');
  assert.equal(decision.category, 'group_address');
  assert.equal(decision.reason, 'group_address_open_floor');
  assert.equal(decision.floorState.kind, 'open');
  assert.equal(decision.addressivity.humanA, 0.8);
  assert.equal(decision.addressivity.humanB, 0.8);
  assert.equal(decision.addressivity.vayria, 0.8);
  assert.ok(
    Object.values(decision.addressivity).reduce(
      (total, score) => total + score,
      0,
    ) > 1,
  );
});

test('the controller supports more than two human participants', () => {
  const humanC: Participant = { id: 'humanC', role: 'human' };
  const controller = createController([humanA, humanB, humanC, vayria]);

  const decision = finalize(controller, '今日は晴れだね', humanC.id);

  assert.equal(decision.mode, 'multi_party');
  assert.equal(decision.decision, 'SILENT');
  assert.equal(decision.participantCount, 4);
});

test('one human participant uses the compatible dyadic fallback', () => {
  const controller = createController([humanA, vayria]);

  const decision = finalize(controller, '今日ご飯どうする？', humanA.id);

  assert.equal(decision.decision, 'SPEAK');
  assert.equal(decision.mode, 'dyadic_fallback');
  assert.equal(decision.category, 'fallback');
  assert.equal(decision.reason, 'participants_not_multi_party');
});

test('unknown speaker uses the compatible dyadic fallback', () => {
  const controller = createController();

  const decision = finalize(controller, '今日ご飯どうする？', null);

  assert.equal(decision.decision, 'SPEAK');
  assert.equal(decision.mode, 'dyadic_fallback');
  assert.equal(decision.reason, 'speaker_identity_unavailable');
});

test('the initial context-free runtime records unknown speaker fallback', () => {
  const controller = createParticipationController();

  const decision = controller.evaluateFinalized({
    segmentId: 'context-free-1',
    text: '今日ご飯どうする？',
  });

  assert.equal(decision.mode, 'dyadic_fallback');
  assert.equal(decision.reason, 'speaker_identity_unavailable');
});

test('participation diagnostics do not expose raw transcript text', () => {
  const timeline = createInteractionTimeline();
  const controller = createParticipationController({
    context: createContext(),
    timeline,
  });

  finalize(controller, 'ポテトの話は人間同士です', humanA.id);

  const serialized = JSON.stringify(timeline.snapshot());
  assert.equal(serialized.includes('ポテト'), false);
  assert.equal(
    timeline.snapshot().some((event) => event.kind === 'participation_decision'),
    true,
  );
  const state = controller.getState();
  assert.equal(state.recentUtterances[0]?.text, 'ポテトの話は人間同士です');
});

test('speech overlap is retained until the finalized decision', () => {
  const controller = createController();

  observeSpeech(controller, humanA.id, 'a-1', 100);
  controller.observeSpeechStarted({ speakerId: humanA.id, at: 200 });
  controller.observeSpeechStarted({ speakerId: humanB.id, at: 210 });
  controller.observeSpeechEnded({ speakerId: humanA.id, at: 220 });
  controller.observeSpeechEnded({ speakerId: humanB.id, at: 230 });

  const decision = finalize(
    controller,
    'それでいこう',
    humanB.id,
    'b-2',
    240,
  );

  assert.equal(decision.category, 'overlap');
  assert.equal(controller.getState().overlapState, 'none');
});
