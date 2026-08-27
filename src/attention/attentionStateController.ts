import type {
  Attention,
  AttentionFocus,
  AttentionPriorityHint,
  AttentionPosition,
  AttentionSoftCue,
  AttentionTarget,
  SpatialTargetSelection,
} from '../performer/types.js';
import { CAMERA_ATTENTION_CONFIG } from './attentionMath.js';
import type { CameraTrackingFrame } from './cameraTrackingController.js';

export const ATTENTION_STATES = [
  'Idle',
  'AttendViewer',
  'AttendTarget',
  'Thinking',
  'Recover',
] as const;

export type AttentionState = (typeof ATTENTION_STATES)[number];

export const TASK_CUE_HINT_GRACE_MS = 100;

export interface AttentionStateInput {
  now: number;
  attention: Attention;
  explicitTargetActive: boolean;
  viewerEngaged: boolean;
  thinking: boolean;
  cameraEnabled: boolean;
  cameraTracking: CameraTrackingFrame | null;
}

export interface AttentionStateFrame {
  state: AttentionState;
  target: AttentionTarget;
  strength: number;
  gazeStrength: number;
  position: AttentionPosition | null;
  headPosition: AttentionPosition | null;
  confidence: number;
  focus: AttentionFocus;
  spatialTarget?: SpatialTargetSelection;
  softCue?: AttentionSoftCue;
}

export class AttentionStateController {
  private state: AttentionState = 'Idle';
  private candidateStartedAt: number | null = null;
  private recoveryStartedAt: number | null = null;
  private viewerSource: 'camera' | 'conversation' | null = null;
  private lastTaskCueHint: AttentionPriorityHint | null = null;
  private lastTaskCueAttention: Attention | null = null;
  private lastTaskCueHintAt: number | null = null;

  update(input: AttentionStateInput): AttentionStateFrame {
    const now = Number.isFinite(input.now) ? input.now : 0;
    const tracking = input.cameraTracking;
    const cameraActive = isCameraActive(input.cameraEnabled, tracking);
    const cameraReacquiring =
      input.cameraEnabled && tracking?.state === 'Reacquire';
    const priorityHint = readPriorityHint(input.attention);
    this.rememberTaskCue(priorityHint, input.attention, now);
    const retainedPriorityHint =
      priorityHint ?? this.readRetainedTaskCueHint(input.attention, now);
    const retainedTaskCueAttention =
      priorityHint === null && retainedPriorityHint !== null
        ? this.lastTaskCueAttention ?? input.attention
        : input.attention;
    const explicitTargetActive =
      input.explicitTargetActive && input.attention.targetMode !== 'task-cue';

    if (
      input.attention.targetMode !== 'task-cue' &&
      priorityHint === null
    ) {
      this.clearTaskCue();
    }

    if (
      explicitTargetActive &&
      (input.attention.target === 'chat' || input.attention.target === 'game')
    ) {
      this.clearCandidate();
      this.clearRecovery();
      this.state = 'AttendTarget';
      this.viewerSource = null;
      this.clearTaskCue();
      return this.createTargetFrame(input.attention);
    }

    if (input.thinking) {
      this.clearCandidate();
      this.clearRecovery();
      this.state = 'Thinking';
      this.viewerSource = null;
      return this.createThinkingFrame();
    }

    if (input.viewerEngaged) {
      this.clearCandidate();
      this.clearRecovery();
      this.state = 'AttendViewer';
      this.viewerSource = 'conversation';
      return this.createViewerFrame(input.attention, tracking, 'conversation');
    }

    if (this.state === 'AttendViewer') {
      if (this.viewerSource === 'conversation') {
        if (retainedPriorityHint) {
          return this.beginPriorityHint(
            retainedPriorityHint,
            retainedTaskCueAttention,
          );
        }
        return this.beginRecovery(now);
      }
      if (cameraActive) {
        return this.createViewerFrame(input.attention, tracking, 'camera');
      }
      if (retainedPriorityHint) {
        return this.beginPriorityHint(
          retainedPriorityHint,
          retainedTaskCueAttention,
        );
      }
      return this.beginRecovery(now);
    }

    if (this.state === 'AttendTarget' || this.state === 'Thinking') {
      if (cameraReacquiring) {
        this.state = 'AttendViewer';
        this.viewerSource = 'camera';
        this.clearRecovery();
        return this.createViewerFrame(input.attention, tracking, 'camera');
      }
      if (retainedPriorityHint) {
        return this.beginPriorityHint(
          retainedPriorityHint,
          retainedTaskCueAttention,
        );
      }
      return this.beginRecovery(now);
    }

    if (this.state === 'Recover') {
      if (cameraReacquiring) {
        this.state = 'AttendViewer';
        this.viewerSource = 'camera';
        this.clearRecovery();
        return this.createViewerFrame(input.attention, tracking, 'camera');
      }
      if (retainedPriorityHint) {
        return this.beginPriorityHint(
          retainedPriorityHint,
          retainedTaskCueAttention,
        );
      }
      if (
        this.recoveryStartedAt !== null &&
        now - this.recoveryStartedAt >= CAMERA_ATTENTION_CONFIG.recoverMs
      ) {
        this.state = 'Idle';
        this.viewerSource = null;
        this.clearRecovery();
      } else {
        return this.createRecoverFrame();
      }
    }

    if (this.state === 'Idle' && cameraReacquiring) {
      this.state = 'AttendViewer';
      this.viewerSource = 'camera';
      this.clearCandidate();
      return this.createViewerFrame(input.attention, tracking, 'camera');
    }

    if (this.state === 'Idle' && retainedPriorityHint) {
      return this.beginPriorityHint(
        retainedPriorityHint,
        retainedTaskCueAttention,
      );
    }

    const cameraCandidate =
      input.cameraEnabled && tracking?.state === 'Tracking' && cameraActive;
    if (this.state === 'Idle' && cameraCandidate) {
      if (this.candidateStartedAt === null) {
        this.candidateStartedAt = now;
      }
      if (
        now - this.candidateStartedAt >=
        CAMERA_ATTENTION_CONFIG.candidateAcquisitionMs
      ) {
        this.state = 'AttendViewer';
        this.viewerSource = 'camera';
        this.clearCandidate();
        return this.createViewerFrame(input.attention, tracking, 'camera');
      }
    } else {
      this.clearCandidate();
    }

    return this.createIdleFrame();
  }

  reset(): void {
    this.state = 'Idle';
    this.clearCandidate();
    this.clearRecovery();
    this.viewerSource = null;
    this.clearTaskCue();
  }

  private beginRecovery(now: number): AttentionStateFrame {
    this.clearCandidate();
    this.viewerSource = null;
    if (this.state !== 'Recover') {
      this.state = 'Recover';
      this.recoveryStartedAt = now;
    }
    return this.createRecoverFrame();
  }

  private beginPriorityHint(
    hint: AttentionPriorityHint,
    attention: Attention,
  ): AttentionStateFrame {
    this.clearCandidate();
    this.clearRecovery();
    this.state = 'AttendTarget';
    this.viewerSource = null;
    return this.createPriorityHintFrame(hint, attention);
  }

  private createIdleFrame(): AttentionStateFrame {
    return {
      state: 'Idle',
      target: 'none',
      strength: 0,
      gazeStrength: 0,
      position: null,
      headPosition: null,
      confidence: 0,
      focus: createFocus('idle', 'released', 0),
    };
  }

  private createRecoverFrame(): AttentionStateFrame {
    return {
      state: 'Recover',
      target: 'none',
      strength: 0,
      gazeStrength: 0,
      position: null,
      headPosition: null,
      confidence: 0,
      focus: createFocus('idle', 'released', 0),
    };
  }

  private createThinkingFrame(): AttentionStateFrame {
    return {
      state: 'Thinking',
      target: 'none',
      strength: 0.28,
      gazeStrength: 1,
      position: null,
      headPosition: null,
      confidence: 0,
      focus: createFocus('idle', 'focused', 1),
    };
  }

  private createTargetFrame(attention: Attention): AttentionStateFrame {
    return {
      state: 'AttendTarget',
      target: attention.target,
      strength: Math.max(0.55, clampStrength(attention.strength)),
      gazeStrength: readAttentionGazeStrength(attention),
      position: null,
      headPosition: null,
      confidence: 0,
      focus: createFocus('screen', 'focused', 1),
      spatialTarget:
        attention.spatialTarget?.kind === attention.target
          ? attention.spatialTarget
          : undefined,
    };
  }

  private createPriorityHintFrame(
    hint: AttentionPriorityHint,
    attention: Attention,
  ): AttentionStateFrame {
    return {
      state: 'AttendTarget',
      target: hint.target,
      strength: Math.max(0.55, clampStrength(attention.strength)),
      gazeStrength: readGazeStrength(hint),
      position: null,
      headPosition: null,
      confidence: 0,
      focus: createFocus('screen', 'focused', 1),
      spatialTarget:
        hint.spatialTarget?.kind === hint.target
          ? hint.spatialTarget
          : undefined,
      softCue: readSecondarySoftCue(attention, hint.target),
    };
  }

  private createViewerFrame(
    attention: Attention,
    tracking: CameraTrackingFrame | null,
    source: 'camera' | 'conversation',
  ): AttentionStateFrame {
    const cameraPosition =
      tracking && tracking.state !== 'Lost' ? tracking.eyePosition : null;
    const cameraHeadPosition =
      tracking && tracking.state !== 'Lost' ? tracking.headPosition : null;
    const cameraConfidence = tracking?.focus.confidence ?? 0;
    const focus =
      source === 'conversation'
        ? createFocus('user', 'focused', 1)
        : tracking?.focus ?? createFocus('user', 'focused', 0);

    return {
      state: 'AttendViewer',
      target: 'viewer',
      strength:
        cameraPosition !== null
          ? Math.max(0.6, clampStrength(attention.strength))
          : 0.72,
      gazeStrength: 1,
      position: cameraPosition,
      headPosition: cameraHeadPosition,
      confidence: cameraPosition !== null ? cameraConfidence : 0,
      focus,
      softCue: readViewerSoftCue(attention),
    };
  }

  private clearCandidate(): void {
    this.candidateStartedAt = null;
  }

  private clearRecovery(): void {
    this.recoveryStartedAt = null;
  }

  private rememberTaskCue(
    priorityHint: AttentionPriorityHint | null,
    attention: Attention,
    now: number,
  ): void {
    if (priorityHint === null || attention.targetMode !== 'task-cue') return;
    this.lastTaskCueHint = {
      ...priorityHint,
      spatialTarget: priorityHint.spatialTarget
        ? { ...priorityHint.spatialTarget }
        : undefined,
    };
    this.lastTaskCueAttention = {
      ...attention,
      spatialTarget: attention.spatialTarget
        ? { ...attention.spatialTarget }
        : undefined,
      priorityHint: this.lastTaskCueHint,
      softCue: attention.softCue
        ? {
            ...attention.softCue,
            spatialTarget: { ...attention.softCue.spatialTarget },
          }
        : undefined,
    };
    this.lastTaskCueHintAt = now;
  }

  private readRetainedTaskCueHint(
    attention: Attention,
    now: number,
  ): AttentionPriorityHint | null {
    if (
      attention.targetMode !== 'task-cue' ||
      this.lastTaskCueHint === null ||
      this.lastTaskCueHintAt === null ||
      now - this.lastTaskCueHintAt > TASK_CUE_HINT_GRACE_MS
    ) {
      return null;
    }
    return this.lastTaskCueHint;
  }

  private clearTaskCue(): void {
    this.lastTaskCueHint = null;
    this.lastTaskCueAttention = null;
    this.lastTaskCueHintAt = null;
  }
}

function readPriorityHint(
  attention: Attention,
): AttentionPriorityHint | null {
  const hint = attention.priorityHint;
  if (!hint || !Number.isFinite(hint.salience) || hint.salience <= 0) {
    return null;
  }
  return hint;
}

function readGazeStrength(hint: AttentionPriorityHint): number {
  if (hint.gazeStrength === undefined) return 1;
  if (!Number.isFinite(hint.gazeStrength)) return 1;
  return clampStrength(hint.gazeStrength);
}

function readAttentionGazeStrength(attention: Attention): number {
  if (attention.gazeStrength === undefined) return 1;
  if (!Number.isFinite(attention.gazeStrength)) return 1;
  return clampStrength(attention.gazeStrength);
}

function readSecondarySoftCue(
  attention: Attention,
  selectedTarget: AttentionTarget,
): AttentionSoftCue | undefined {
  const cue = readSoftCue(attention);
  if (!cue || cue.target === selectedTarget) return undefined;
  return {
    ...cue,
    strength: Math.min(cue.strength, 0.12),
  };
}

function readViewerSoftCue(attention: Attention): AttentionSoftCue | undefined {
  return readSecondarySoftCue(attention, 'viewer');
}

function readSoftCue(attention: Attention): AttentionSoftCue | undefined {
  const cue = attention.softCue;
  if (
    !cue ||
    !Number.isFinite(cue.strength) ||
    cue.strength <= 0 ||
    cue.spatialTarget.kind !== cue.target
  ) {
    return undefined;
  }
  return {
    ...cue,
    strength: clampStrength(cue.strength),
  };
}

function isCameraActive(
  cameraEnabled: boolean,
  tracking: CameraTrackingFrame | null,
): boolean {
  return (
    cameraEnabled &&
    tracking !== null &&
    tracking.state !== 'Lost' &&
    tracking.eyePosition !== null
  );
}

function createFocus(
  target: AttentionFocus['target'],
  phase: AttentionFocus['phase'],
  confidence: number,
): AttentionFocus {
  return {
    target,
    phase,
    confidence: clampStrength(confidence),
  };
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
