import assert from 'node:assert/strict';
import test from 'node:test';
import { getVisibleCardStateLabel } from '../src/cards/cardPresentation.js';
import {
  getExhibitionUiPhasePresentation,
  resolveExhibitionUiMode,
  resolveExhibitionUiPhase,
  type ExhibitionUiPhase,
  type ExhibitionUiPhaseInput,
} from '../src/exhibition/exhibitionUi.js';

const IDLE_INPUT: ExhibitionUiPhaseInput = {
  conversationStatus: 'idle',
  hasError: false,
  needsPlaybackGesture: false,
  voiceInputEnabled: false,
  voiceInputPhase: 'idle',
};

test('candidate is the default exhibition UI mode', () => {
  assert.equal(resolveExhibitionUiMode('', undefined), 'candidate');
  assert.equal(resolveExhibitionUiMode('?exhibitionUi=unknown', 'unknown'), 'candidate');
});

test('valid query mode wins and invalid query falls back to the environment', () => {
  assert.equal(
    resolveExhibitionUiMode('?exhibitionUi=baseline', 'candidate'),
    'baseline',
  );
  assert.equal(
    resolveExhibitionUiMode('?exhibitionUi=candidate', 'baseline'),
    'candidate',
  );
  assert.equal(
    resolveExhibitionUiMode('?exhibitionUi=unknown', 'baseline'),
    'baseline',
  );
});

test('exhibition UI exposes every presentation phase', () => {
  const cases: Array<[Partial<ExhibitionUiPhaseInput>, ExhibitionUiPhase]> = [
    [{}, 'idle'],
    [
      { voiceInputEnabled: true, voiceInputPhase: 'listening' },
      'listening',
    ],
    [
      { voiceInputEnabled: true, voiceInputPhase: 'speech_detected' },
      'listening',
    ],
    [{ voiceInputPhase: 'utterance_finalized' }, 'thinking'],
    [{ conversationStatus: 'thinking' }, 'thinking'],
    [{ conversationStatus: 'synthesizing' }, 'synthesizing'],
    [{ conversationStatus: 'speaking' }, 'speaking'],
    [{ hasError: true }, 'error'],
    [{ needsPlaybackGesture: true }, 'permission'],
  ];

  for (const [input, expected] of cases) {
    assert.equal(resolveExhibitionUiPhase({ ...IDLE_INPUT, ...input }), expected);
    const presentation = getExhibitionUiPhasePresentation(expected);
    assert.ok(presentation.label.length > 0);
    assert.ok(presentation.mark.length > 0);
  }
});

test('permission and error interrupt normal conversation phases in order', () => {
  assert.equal(
    resolveExhibitionUiPhase({
      ...IDLE_INPUT,
      conversationStatus: 'speaking',
      hasError: true,
    }),
    'error',
  );
  assert.equal(
    resolveExhibitionUiPhase({
      ...IDLE_INPUT,
      conversationStatus: 'speaking',
      hasError: true,
      needsPlaybackGesture: true,
    }),
    'permission',
  );
});

test('candidate card labels identify action and destination without color', () => {
  assert.equal(getVisibleCardStateLabel('active', 'none'), '作用中');
  assert.equal(getVisibleCardStateLabel('supporting', 'none'), '補助');
  assert.equal(getVisibleCardStateLabel('normal', 'drop-target'), 'ここへ');
  assert.equal(
    getVisibleCardStateLabel('normal', 'pending-insertion'),
    '返答待ち',
  );
  assert.equal(getVisibleCardStateLabel('normal', 'inserted'), '作用');
  assert.equal(getVisibleCardStateLabel('normal', 'none'), null);
  assert.equal(getVisibleCardStateLabel('disabled', 'none'), null);
});
