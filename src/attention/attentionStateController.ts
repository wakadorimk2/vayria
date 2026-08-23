import type {
  Attention,
  AttentionFocus,
  AttentionPosition,
  AttentionTarget,
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
  position: AttentionPosition | null;
  headPosition: AttentionPosition | null;
  confidence: number;
  focus: AttentionFocus;
}

export class AttentionStateController {
  private state: AttentionState = 'Idle';
  private candidateStartedAt: number | null = null;
  private recoveryStartedAt: number | null = null;
  private viewerSource: 'camera' | 'conversation' | null = null;

  update(input: AttentionStateInput): AttentionStateFrame {
    const now = Number.isFinite(input.now) ? input.now : 0;
    const tracking = input.cameraTracking;
    const cameraActive = isCameraActive(input.cameraEnabled, tracking);
    const cameraReacquiring =
      input.cameraEnabled && tracking?.state === 'Reacquire';

    if (
      input.explicitTargetActive &&
      (input.attention.target === 'chat' || input.attention.target === 'game')
    ) {
      this.clearCandidate();
      this.clearRecovery();
      this.state = 'AttendTarget';
      this.viewerSource = null;
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
        return this.beginRecovery(now);
      }
      if (cameraActive) {
        return this.createViewerFrame(input.attention, tracking, 'camera');
      }
      return this.beginRecovery(now);
    }

    if (this.state === 'AttendTarget' || this.state === 'Thinking') {
      return this.beginRecovery(now);
    }

    if (this.state === 'Recover') {
      if (cameraReacquiring) {
        this.state = 'AttendViewer';
        this.viewerSource = 'camera';
        this.clearRecovery();
        return this.createViewerFrame(input.attention, tracking, 'camera');
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

  private createIdleFrame(): AttentionStateFrame {
    return {
      state: 'Idle',
      target: 'none',
      strength: 0,
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
      position: null,
      headPosition: null,
      confidence: 0,
      focus: createFocus('screen', 'focused', 1),
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
      position: cameraPosition,
      headPosition: cameraHeadPosition,
      confidence: cameraPosition !== null ? cameraConfidence : 0,
      focus,
    };
  }

  private clearCandidate(): void {
    this.candidateStartedAt = null;
  }

  private clearRecovery(): void {
    this.recoveryStartedAt = null;
  }
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
