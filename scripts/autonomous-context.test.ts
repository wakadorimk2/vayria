import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyViewerIntent,
  INITIAL_AUTONOMOUS_CONTEXT,
  recordViewerIntent,
} from '../src/conversation/autonomousContext.js';

test('classifies viewer speech acts without storing the raw message', () => {
  assert.equal(
    classifyViewerIntent('ヴェイリア、聞こえる？'),
    'direct_address',
  );
  assert.equal(classifyViewerIntent('ねえ'), 'call');
  assert.equal(classifyViewerIntent('それどう思う？'), 'question');
  assert.equal(classifyViewerIntent('紹介して'), 'request');
  assert.equal(classifyViewerIntent('整理していきます'), 'action_commitment');
  assert.equal(classifyViewerIntent('ここで終わりにします'), 'closing');
  assert.equal(
    classifyViewerIntent('静かに、ここで終わりにしましょう'),
    'closing',
  );
  assert.equal(classifyViewerIntent('ここで終わりにしますか？'), 'question');
  assert.equal(classifyViewerIntent('作業を終わりにします'), 'statement');
  assert.equal(classifyViewerIntent('今日はさ…'), 'unfinished');
  assert.equal(classifyViewerIntent('うん'), 'backchannel');
  assert.equal(classifyViewerIntent('今日は雨だった'), 'statement');
});

test('recording viewer input updates intent age and engagement state', () => {
  const current = {
    ...INITIAL_AUTONOMOUS_CONTEXT,
    topic: '朝ごはん',
    topicTurns: 3,
    viewerIntent: 'statement' as const,
    viewerTurnsSince: 4,
  };

  assert.deepEqual(recordViewerIntent(current, 'それどう思う？'), {
    topic: '朝ごはん',
    topicTurns: 3,
    viewerIntent: 'question',
    viewerTurnsSince: 0,
    viewerEngagement: 'available',
  });
});

test('explicit closing settles the conversation until substantive re-entry', () => {
  const settled = recordViewerIntent(
    INITIAL_AUTONOMOUS_CONTEXT,
    'ここで終わりにします',
  );
  assert.equal(settled.viewerIntent, 'closing');
  assert.equal(settled.viewerEngagement, 'settled');

  const afterBackchannel = recordViewerIntent(settled, 'うん');
  assert.equal(afterBackchannel.viewerIntent, 'backchannel');
  assert.equal(afterBackchannel.viewerEngagement, 'settled');

  const reopened = recordViewerIntent(afterBackchannel, 'それどう思う？');
  assert.equal(reopened.viewerIntent, 'question');
  assert.equal(reopened.viewerEngagement, 'available');
});
