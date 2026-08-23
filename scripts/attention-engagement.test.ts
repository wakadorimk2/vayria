import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  ATTENTION_ENGAGEMENT_CONFIG,
  AttentionEngagementController,
} from '../src/attention/attentionEngagementController.js';

function cameraInput() {
  return {
    state: 'AttendViewer' as const,
    viewerEngaged: false,
    hasCameraPosition: true,
  };
}

test('camera viewer entry creates a small, one-shot attention pulse', () => {
  const controller = new AttentionEngagementController();

  const entry = controller.update(0, cameraInput());
  const held = controller.update(0.1, cameraInput());
  const noRetrigger = controller.update(0.1, cameraInput());

  assert.equal(entry, ATTENTION_ENGAGEMENT_CONFIG.cameraEntryPeak);
  assert.equal(held, ATTENTION_ENGAGEMENT_CONFIG.cameraEntryPeak);
  assert.equal(noRetrigger, ATTENTION_ENGAGEMENT_CONFIG.cameraEntryPeak);
});

test('viewer engagement rising edge creates the stronger pulse', () => {
  const controller = new AttentionEngagementController();
  controller.update(0, cameraInput());

  const engaged = controller.update(0, {
    ...cameraInput(),
    viewerEngaged: true,
  });
  const held = controller.update(0.1, {
    ...cameraInput(),
    viewerEngaged: true,
  });

  assert.equal(engaged, ATTENTION_ENGAGEMENT_CONFIG.viewerEngagedPeak);
  assert.equal(held, ATTENTION_ENGAGEMENT_CONFIG.viewerEngagedPeak);
});

test('attention decays after its hold period without retriggering', () => {
  const controller = new AttentionEngagementController();
  controller.update(0, {
    ...cameraInput(),
    viewerEngaged: true,
  });

  const afterHold = controller.update(
    ATTENTION_ENGAGEMENT_CONFIG.holdMs / 1_000,
    { ...cameraInput(), viewerEngaged: true },
  );
  const halfway = controller.update(
    ATTENTION_ENGAGEMENT_CONFIG.decayMs / 2_000,
    { ...cameraInput(), viewerEngaged: true },
  );
  const finished = controller.update(
    ATTENTION_ENGAGEMENT_CONFIG.decayMs / 2_000,
    { ...cameraInput(), viewerEngaged: true },
  );

  assert.equal(afterHold, ATTENTION_ENGAGEMENT_CONFIG.viewerEngagedPeak);
  assert.ok(halfway > 0 && halfway < afterHold);
  assert.equal(finished, 0);
});

test('thinking, target, and recovery release camera head attention', () => {
  const controller = new AttentionEngagementController();
  controller.update(0, {
    ...cameraInput(),
    viewerEngaged: true,
  });

  const thinking = controller.update(0.1, {
    state: 'Thinking',
    viewerEngaged: false,
    hasCameraPosition: true,
  });
  const target = controller.update(0.1, {
    state: 'AttendTarget',
    viewerEngaged: false,
    hasCameraPosition: true,
  });
  const recover = controller.update(0.1, {
    state: 'Recover',
    viewerEngaged: false,
    hasCameraPosition: true,
  });

  assert.ok(thinking < ATTENTION_ENGAGEMENT_CONFIG.viewerEngagedPeak);
  assert.ok(target < thinking);
  assert.ok(recover < target);
});

test('camera presence does not pulse without a camera position', () => {
  const controller = new AttentionEngagementController();

  const frame = controller.update(0, {
    state: 'AttendViewer',
    viewerEngaged: false,
    hasCameraPosition: false,
  });

  assert.equal(frame, 0);
});
