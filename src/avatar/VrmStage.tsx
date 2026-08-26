import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from 'react';
import {
  Box3,
  Clock,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMExpressionPresetName,
  VRMLoaderPlugin,
  VRMUtils,
} from '@pixiv/three-vrm';
import { BlinkController } from './BlinkController';
import { ATTENTION_ENERGY_CONFIG } from '../attention/attentionEnergyController';
import { EmotionExpressionController } from './EmotionExpressionController';
import { IdleGazeController } from './idleGaze';
import {
  blendGazeTarget,
  mapCameraAttentionToHeadBias,
  mapCameraAttentionToViewerTarget,
} from './attentionTarget';
import { AttentionEngagementController } from '../attention/attentionEngagementController';
import { AttentionVisualSmoother } from '../attention/attentionVisualSmoother';
import { AttentionStateController } from '../attention/attentionStateController';
import { CameraTrackingController } from '../attention/cameraTrackingController';
import { applyBasePose, IdleController } from './idleMotion';
import {
  createLifeDynamicsProfile,
  LifeDynamics,
  resolveLifeDynamicsProfileId,
  type LifeDynamicsInputs,
  type LifeDynamicsSnapshot,
} from './lifeDynamics';
import { LifeDynamicsBlinkAdapter } from './lifeDynamicsBlinkAdapter';
import { LifeDynamicsLifeAdapter } from './lifeDynamicsLifeAdapter';
import { LifeDynamicsOrientingAdapter } from './lifeDynamicsOrientingAdapter';
import { SpatialTargetBridge } from './spatialTargetBridge';
import { SpatialTargetWorldCache } from './spatialTargetContinuity';
import {
  SPATIAL_TARGET_OUTPUT_TIMING,
  SpatialHeadProjectionSmoother,
  SpatialTargetOutputSmoother,
} from './spatialTargetOutputSmoother';
import type {
  SpatialTargetRect,
  SpatialTargetRegistry,
} from '../attention/spatialTargetRegistry';
import { frameAvatar } from './cameraPreset';
import { setupStageLighting } from './stageLighting';
import { SavedMotionCatalog } from './motion/motionCatalog';
import { MotionPlayer } from './motion/motionPlayer';
import {
  CARD_PREVIEW_LIGHTING,
  EXHIBITION_PORTRAIT_CAMERA,
  STAGE_PRESET,
} from './stagePreset';
import type { Emotion } from '../character/emotion';
import type {
  AttentionReader,
  PerformancePlan,
  SpatialTargetSelection,
} from '../performer/types';
import type { ListeningReactionCue } from '../voice/voiceInput';

const MODEL_URL = `${import.meta.env.BASE_URL}avatar/model.vrm`;

const LISTENING_NOD_DURATION_SECONDS = 0.48;
const LISTENING_NOD_DEGREES = -4;
const LISTENING_REACTION_EXIT_BLEND_MS = 400;

function getListeningNodDegrees(elapsedSeconds: number): number {
  if (elapsedSeconds < 0 || elapsedSeconds >= LISTENING_NOD_DURATION_SECONDS) {
    return 0;
  }
  const progress = elapsedSeconds / LISTENING_NOD_DURATION_SECONDS;
  return LISTENING_NOD_DEGREES * Math.sin(progress * Math.PI);
}

function readStageRect(element: HTMLElement): SpatialTargetRect {
  const rect = element.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    width: rect.width,
    height: rect.height,
  };
}

function formatSpatialTargetSelection(
  selection: SpatialTargetSelection | null,
): string {
  return selection === null
    ? 'none'
    : `${selection.kind}:${selection.anchor}`;
}

function toDebugWorld(
  target: Vector3 | null,
): { x: number; y: number; z: number } | null {
  if (
    target === null ||
    !Number.isFinite(target.x) ||
    !Number.isFinite(target.y) ||
    !Number.isFinite(target.z)
  ) {
    return null;
  }
  return {
    x: target.x,
    y: target.y,
    z: target.z,
  };
}

function clampGazeStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}

function waitForMotionDelay(
  delayMs: number,
  signal: AbortSignal,
): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve(false);
      return;
    }

    let settled = false;
    const finish = (played: boolean) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      signal.removeEventListener('abort', handleAbort);
      resolve(played);
    };
    const handleAbort = () => finish(false);
    const timer = window.setTimeout(
      () => finish(true),
      Math.max(0, Math.round(delayMs)),
    );
    signal.addEventListener('abort', handleAbort, { once: true });
  });
}

function createListeningReactionPlan(
  assetId: string | null,
  requestId: number,
): PerformancePlan {
  return {
    planId: `voice-reaction-${requestId}`,
    trigger: 'external_stimulus',
    intent: 'react_nonverbally',
    preReaction: {
      leadBeforeSpeechMs: 0,
      gaze: {
        target: 'viewer',
        directness: 1,
      },
      motion: {
        weight: 1,
        headYawBias: 0,
      },
    },
    ...(assetId === null ? {} : { motion: { assetId } }),
    timing: {
      motionLeadMs: 0,
      motionEnterBlendMs: 180,
      motionExitBlendMs: LISTENING_REACTION_EXIT_BLEND_MS,
      motionPreparationTimeoutMs: 1_500,
      postSpeechHoldMs: 0,
    },
    activeDirectionIds: [],
  };
}

type AvatarPerformancePhase =
  | 'pre_reaction'
  | 'motion'
  | 'speech'
  | 'tail'
  | 'recovery';

interface AvatarPerformanceState {
  plan: PerformancePlan;
  phase: AvatarPerformancePhase;
  recoveryStartedAt: number | null;
}

interface VrmStageProps {
  attentionReader: AttentionReader;
  emotion: Emotion;
  isExhibitionMode?: boolean;
  listeningReaction?: ListeningReactionCue;
  motionScale?: number;
  mouthOpen: number;
  onReady?: () => void;
  performancePlan?: PerformancePlan;
  sessionGeneration?: number;
  spatialTargetRegistry?: SpatialTargetRegistry;
  stageVariant?: 'default' | 'card-preview';
}

export interface VrmStageHandle {
  prepareMotion(
    plan: PerformancePlan,
    signal?: AbortSignal,
  ): Promise<boolean>;
  startPreparedMotion(planId: string): number | null;
  markSpeechStart(planId: string, startedAt: number): void;
  markSpeechEnd(planId: string, endedAt: number): void;
  finishMotion(planId?: string): void;
  stopMotion(planId?: string): void;
  playReactionMotion(assetId: string, requestId: number): Promise<boolean>;
  stopReactionMotion(): void;
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

interface LifeDynamicsPocOptions {
  enabled: boolean;
  debug: boolean;
  profileId: ReturnType<typeof resolveLifeDynamicsProfileId>;
}

interface SpatialTargetDebugSnapshot {
  readonly primarySource: string;
  readonly primaryWorld: { x: number; y: number; z: number } | null;
  readonly attentionMode: string;
  readonly attentionEnergy: number;
  readonly softCueSource: string | null;
  readonly softCueWorld: { x: number; y: number; z: number } | null;
  readonly headProjection: { yawDegrees: number; pitchDegrees: number };
  readonly valid: boolean;
  readonly owner: string;
  readonly releaseReason: string;
  readonly gazeStrength: number;
}

function getLifeDynamicsPocOptions(): LifeDynamicsPocOptions {
  if (typeof window === 'undefined') {
    return { enabled: false, debug: false, profileId: '1.0x' };
  }

  const params = new URLSearchParams(window.location.search);
  const enabled = params.get('life-dynamics-poc') === '1';
  return {
    enabled,
    debug: enabled && params.get('life-dynamics-debug') === '1',
    profileId: resolveLifeDynamicsProfileId(
      params.get('life-dynamics-profile'),
    ),
  };
}

const runtimeLifeDynamicsRandom = (): number => Math.random();

export const VrmStage = forwardRef<VrmStageHandle, VrmStageProps>(
  function VrmStage(
    {
      attentionReader,
      emotion,
      isExhibitionMode = false,
      listeningReaction,
      motionScale = 1,
      mouthOpen,
      onReady,
      performancePlan,
      sessionGeneration = 0,
      spatialTargetRegistry,
      stageVariant = 'default',
    },
    ref,
  ) {
    const lifeDynamicsPocOptions = getLifeDynamicsPocOptions();
    const lifeDynamicsPocEnabled = lifeDynamicsPocOptions.enabled;
    const lifeDynamicsDebugEnabled = lifeDynamicsPocOptions.debug;
    const lifeDynamicsProfileId = lifeDynamicsPocOptions.profileId;
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouthOpenRef = useRef(mouthOpen);
    const emotionRef = useRef(emotion);
    const attentionReaderRef = useRef(attentionReader);
    const listeningReactionRef = useRef(listeningReaction);
    const listeningReactionIdRef = useRef<number | null>(
      listeningReaction?.id ?? null,
    );
    const listeningReactionStartedAtRef = useRef(0);
    const performanceStateRef = useRef<AvatarPerformanceState | null>(null);
    const motionScaleRef = useRef(motionScale);
    const performancePlanRef = useRef(performancePlan);
    const onReadyRef = useRef(onReady);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [expressionWarning, setExpressionWarning] = useState('');
    const [lifeDynamicsDebugSnapshot, setLifeDynamicsDebugSnapshot] =
      useState<LifeDynamicsSnapshot | null>(null);
    const [spatialTargetDebugSnapshot, setSpatialTargetDebugSnapshot] =
      useState<SpatialTargetDebugSnapshot | null>(null);
    const loadedVrmRef = useRef<VRM | null>(null);
    const lifeDynamicsRef = useRef<LifeDynamics | null>(null);
    const lifeDynamicsBlinkAdapterRef =
      useRef<LifeDynamicsBlinkAdapter | null>(null);
    const lifeDynamicsLifeAdapterRef =
      useRef<LifeDynamicsLifeAdapter | null>(null);
    const lifeDynamicsOrientingAdapterRef =
      useRef<LifeDynamicsOrientingAdapter | null>(null);
    const lifeDynamicsDebugLastLogAtRef = useRef(0);
    const motionPlayerRef = useRef<MotionPlayer | null>(null);
    const motionCatalogRef = useRef(new SavedMotionCatalog());
    const motionAbortControllerRef = useRef<AbortController | null>(null);
    const motionRequestGenerationRef = useRef(0);
    const preparedMotionPlanIdRef = useRef<string | null>(null);
    const preparedMotionPromiseRef = useRef<{
      planId: string;
      assetId: string;
      promise: Promise<boolean>;
    } | null>(null);
    const activeMotionPlanIdRef = useRef<string | null>(null);
    const reactionMotionRequestRef = useRef(0);
    const reactionMotionPlanIdRef = useRef<string | null>(null);
    const reactionMotionControllerRef = useRef<AbortController | null>(null);

    useEffect(() => {
      mouthOpenRef.current = mouthOpen;
    }, [mouthOpen]);

    useEffect(() => {
      emotionRef.current = emotion;
    }, [emotion]);

    useEffect(() => {
      attentionReaderRef.current = attentionReader;
    }, [attentionReader]);

    useEffect(() => {
      const nextId = listeningReaction?.id ?? null;
      if (nextId !== listeningReactionIdRef.current) {
        const previousId = listeningReactionIdRef.current;
        listeningReactionIdRef.current = nextId;
        listeningReactionStartedAtRef.current =
          nextId === null ? 0 : performance.now();

        if (
          listeningReaction &&
          nextId !== null &&
          !performancePlan
        ) {
          performanceStateRef.current = {
            plan: createListeningReactionPlan(null, nextId),
            phase: 'pre_reaction',
            recoveryStartedAt: null,
          };
        } else if (
          nextId === null &&
          previousId !== null &&
          performanceStateRef.current?.plan.planId ===
            `voice-reaction-${previousId}`
        ) {
          performanceStateRef.current.phase = 'recovery';
          performanceStateRef.current.recoveryStartedAt = performance.now();
        }
      }
      listeningReactionRef.current = listeningReaction;
    }, [listeningReaction, performancePlan]);

    useEffect(() => {
      onReadyRef.current = onReady;
    }, [onReady]);

    const prepareMotion = useCallback(
      async (plan: PerformancePlan, signal?: AbortSignal): Promise<boolean> => {
        const assetId = plan.motion?.assetId;
        const vrm = loadedVrmRef.current;
        const player = motionPlayerRef.current;
        if (motionScaleRef.current <= 0) {
          player?.stop();
          return false;
        }
        if (!assetId || !vrm || !player) return false;
        if (signal?.aborted) return false;
        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
          player.stop();
          return false;
        }

        if (
          preparedMotionPromiseRef.current?.planId === plan.planId &&
          preparedMotionPromiseRef.current.assetId === assetId
        ) {
          return preparedMotionPromiseRef.current.promise;
        }

        const requestGeneration = ++motionRequestGenerationRef.current;
        motionAbortControllerRef.current?.abort();
        const controller = new AbortController();
        const abortFromCaller = () => controller.abort();
        signal?.addEventListener('abort', abortFromCaller, { once: true });
        motionAbortControllerRef.current = controller;
        preparedMotionPlanIdRef.current = null;
        activeMotionPlanIdRef.current = null;
        player.stop();

        const promise = (async () => {
          try {
            const asset = await motionCatalogRef.current.get(
              assetId,
              controller.signal,
            );
            if (
              requestGeneration !== motionRequestGenerationRef.current ||
              controller.signal.aborted ||
              loadedVrmRef.current !== vrm
            ) {
              return false;
            }

            const prepared = await player.prepare(
              asset,
              vrm,
              controller.signal,
              {
                enterMs: plan.timing.motionEnterBlendMs,
                exitMs: plan.timing.motionExitBlendMs,
              },
            );
            if (
              !prepared ||
              requestGeneration !== motionRequestGenerationRef.current ||
              controller.signal.aborted ||
              loadedVrmRef.current !== vrm
            ) {
              return false;
            }

            preparedMotionPlanIdRef.current = plan.planId;
            return true;
          } catch (error) {
            if (
              controller.signal.aborted ||
              requestGeneration !== motionRequestGenerationRef.current
            ) {
              return false;
            }
            player.stop();
            console.warn(
              'Performer motion fallback: saved asset was not prepared.',
              {
                assetId,
                error: error instanceof Error ? error.message : String(error),
              },
            );
            return false;
          } finally {
            signal?.removeEventListener('abort', abortFromCaller);
            if (preparedMotionPromiseRef.current?.planId === plan.planId) {
              preparedMotionPromiseRef.current = null;
            }
          }
        })();

        preparedMotionPromiseRef.current = {
          planId: plan.planId,
          assetId,
          promise,
        };
        return promise;
      },
      [],
    );

    const stopMotion = useCallback((planId?: string) => {
      if (!planId && reactionMotionPlanIdRef.current) return;
      if (
        planId &&
        preparedMotionPlanIdRef.current !== planId &&
        activeMotionPlanIdRef.current !== planId &&
        preparedMotionPromiseRef.current?.planId !== planId
      ) {
        return;
      }

      ++motionRequestGenerationRef.current;
      motionAbortControllerRef.current?.abort();
      motionAbortControllerRef.current = null;
      preparedMotionPromiseRef.current = null;
      preparedMotionPlanIdRef.current = null;
      activeMotionPlanIdRef.current = null;
      motionPlayerRef.current?.stop();
      if (
        !planId ||
        performanceStateRef.current?.plan.planId === planId
      ) {
        performanceStateRef.current = null;
      }
    }, []);

    const finishMotion = useCallback((planId?: string) => {
      const performanceState = performanceStateRef.current;
      if (
        performanceState &&
        (!planId || performanceState.plan.planId === planId)
      ) {
        performanceState.phase = 'recovery';
        performanceState.recoveryStartedAt = performance.now();
      }
      if (
        planId &&
        preparedMotionPlanIdRef.current !== planId &&
        activeMotionPlanIdRef.current !== planId &&
        preparedMotionPromiseRef.current?.planId !== planId
      ) {
        return;
      }

      preparedMotionPlanIdRef.current = null;
      motionPlayerRef.current?.requestExit();
    }, []);

    const startPreparedMotion = useCallback((planId: string): number | null => {
      if (preparedMotionPlanIdRef.current !== planId) return null;
      const player = motionPlayerRef.current;
      if (!player?.startPrepared()) return null;
      preparedMotionPlanIdRef.current = null;
      activeMotionPlanIdRef.current = planId;
      const startedAt = performance.now();
      if (performanceStateRef.current?.plan.planId === planId) {
        performanceStateRef.current.phase = 'motion';
        performanceStateRef.current.recoveryStartedAt = null;
      }
      return startedAt;
    }, []);

    const markSpeechStart = useCallback(
      (planId: string): void => {
        const state = performanceStateRef.current;
        if (!state || state.plan.planId !== planId) return;
        state.phase = 'speech';
        state.recoveryStartedAt = null;
      },
      [],
    );

    const markSpeechEnd = useCallback(
      (planId: string): void => {
        const state = performanceStateRef.current;
        if (!state || state.plan.planId !== planId) return;
        state.phase = 'tail';
      },
      [],
    );

    const stopReactionMotion = useCallback(() => {
      reactionMotionRequestRef.current += 1;
      reactionMotionControllerRef.current?.abort();
      reactionMotionControllerRef.current = null;
      const planId = reactionMotionPlanIdRef.current;
      reactionMotionPlanIdRef.current = null;
      if (planId) stopMotion(planId);
    }, [stopMotion]);

    const playReactionMotion = useCallback(
      async (assetId: string, requestId: number): Promise<boolean> => {
        stopReactionMotion();
        if (
          motionScaleRef.current <= 0 ||
          window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ) {
          return false;
        }

        const vrm = loadedVrmRef.current;
        const player = motionPlayerRef.current;
        if (!vrm || !player || player.isPlaying()) return false;

        const generation = ++reactionMotionRequestRef.current;
        const controller = new AbortController();
        reactionMotionControllerRef.current = controller;
        const plan = createListeningReactionPlan(assetId, requestId);
        performanceStateRef.current = {
          plan,
          phase: 'pre_reaction',
          recoveryStartedAt: null,
        };
        reactionMotionPlanIdRef.current = plan.planId;

        try {
          const asset = await motionCatalogRef.current.get(
            assetId,
            controller.signal,
          );
          if (generation !== reactionMotionRequestRef.current) return false;

          const prepared = await prepareMotion(plan, controller.signal);
          if (
            !prepared ||
            generation !== reactionMotionRequestRef.current ||
            controller.signal.aborted
          ) {
            return false;
          }

          if (startPreparedMotion(plan.planId) === null) return false;

          const played = await waitForMotionDelay(
            asset.durationMs,
            controller.signal,
          );
          if (
            !played ||
            generation !== reactionMotionRequestRef.current ||
            controller.signal.aborted
          ) {
            return false;
          }

          finishMotion(plan.planId);
          await waitForMotionDelay(
            LISTENING_REACTION_EXIT_BLEND_MS,
            controller.signal,
          );
          return generation === reactionMotionRequestRef.current;
        } finally {
          if (reactionMotionControllerRef.current === controller) {
            reactionMotionControllerRef.current = null;
          }
          if (reactionMotionPlanIdRef.current === plan.planId) {
            reactionMotionPlanIdRef.current = null;
          }
        }
      },
      [finishMotion, prepareMotion, startPreparedMotion, stopReactionMotion],
    );

    const syncMotionAsset = useCallback(() => {
      const plan = performancePlanRef.current;
      if (!plan?.motion) {
        stopMotion();
        return;
      }
      void prepareMotion(plan);
    }, [prepareMotion, stopMotion]);

    useImperativeHandle(
      ref,
      () => ({
        prepareMotion,
        startPreparedMotion,
        markSpeechStart,
        markSpeechEnd,
        finishMotion,
        stopMotion,
        playReactionMotion,
        stopReactionMotion,
      }),
      [
        finishMotion,
        markSpeechEnd,
        markSpeechStart,
        playReactionMotion,
        prepareMotion,
        startPreparedMotion,
        stopMotion,
        stopReactionMotion,
      ],
    );

    useEffect(() => {
      motionScaleRef.current = motionScale;
      if (motionScale <= 0) {
        stopReactionMotion();
        stopMotion();
        return;
      }

      const plan = performancePlanRef.current;
      if (plan?.motion) void prepareMotion(plan);
    }, [motionScale, prepareMotion, stopMotion, stopReactionMotion]);

    useEffect(() => {
      const previousPlanId = performancePlanRef.current?.planId;
      performancePlanRef.current = performancePlan;
      if (performancePlan) {
        performanceStateRef.current = {
          plan: performancePlan,
          phase: 'pre_reaction',
          recoveryStartedAt: null,
        };
      }
      const playbackState = motionPlayerRef.current?.playbackState ?? 'idle';
      const performanceState = performanceStateRef.current;
      const isGracefulExit =
        !performancePlan &&
        previousPlanId !== undefined &&
        ((activeMotionPlanIdRef.current === previousPlanId &&
          playbackState !== 'idle') ||
          (performanceState?.plan.planId === previousPlanId &&
            performanceState.phase === 'recovery'));
      if (performancePlan?.motion && motionScaleRef.current > 0) {
        void prepareMotion(performancePlan);
      } else if (!isGracefulExit) {
        const reaction = listeningReactionRef.current;
        if (reaction && !reactionMotionPlanIdRef.current) {
          const reactionPlanId = `voice-reaction-${reaction.id}`;
          if (performanceStateRef.current?.plan.planId !== reactionPlanId) {
            performanceStateRef.current = {
              plan: createListeningReactionPlan(null, reaction.id),
              phase: 'pre_reaction',
              recoveryStartedAt: null,
            };
          }
        } else {
          stopMotion();
        }
      }
    }, [performancePlan, prepareMotion, stopMotion]);

    useEffect(() => {
      if (sessionGeneration === 0) return;
      stopReactionMotion();
      stopMotion();
      lifeDynamicsRef.current?.reset(runtimeLifeDynamicsRandom);
      lifeDynamicsBlinkAdapterRef.current?.reset();
      lifeDynamicsLifeAdapterRef.current?.reset();
      lifeDynamicsOrientingAdapterRef.current?.reset();
      setLifeDynamicsDebugSnapshot(null);
      lifeDynamicsDebugLastLogAtRef.current = 0;
    }, [sessionGeneration, stopMotion, stopReactionMotion]);

    useEffect(() => {
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas) return;

      const scene = new Scene();
      const camera = new PerspectiveCamera(
        STAGE_PRESET.camera.fov,
        1,
        0.01,
        50,
      );
      setupStageLighting(
        scene,
        stageVariant === 'card-preview'
          ? CARD_PREVIEW_LIGHTING
          : STAGE_PRESET.lighting,
      );

      let renderer: WebGLRenderer;
      try {
        renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
      } catch {
        queueMicrotask(() => setLoadState('error'));
        return;
      }
      renderer.setClearAlpha(0);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = SRGBColorSpace;

      let disposed = false;
      let loadedVrm: VRM | null = null;
      let animationFrame = 0;
      let mouthExpression: string | null = null;
      let idleController: IdleController | null = null;
      let idleGazeController: IdleGazeController | null = null;
      const attentionStateController = new AttentionStateController();
      const cameraTrackingController = new CameraTrackingController();
      const attentionVisualSmoother = new AttentionVisualSmoother();
      const attentionEngagementController =
        new AttentionEngagementController();
      const spatialTargetBridge = new SpatialTargetBridge();
      const spatialTargetWorldCache = new SpatialTargetWorldCache();
      const spatialEyeSmoother = new SpatialTargetOutputSmoother();
      const spatialHeadSmoother = new SpatialHeadProjectionSmoother();
      const viewerCameraForward = new Vector3();
      const viewerCameraRight = new Vector3();
      const viewerCameraUp = new Vector3();
      const lookAtWorldPosition = new Vector3();
      const thinkingGazeTarget = new Vector3();
      const viewerGazeTarget = new Vector3();
      const lifeDynamicsNeutralTarget = new Vector3();
      const gazeOutputTargetVector = new Vector3();
      const primaryGazeOutputTarget = new Vector3();
      let gazeModelHeight = 1;
      let blinkController: BlinkController | null = null;
      let emotionController: EmotionExpressionController | null = null;
      let appliedEmotion: Emotion | null = null;
      let stageRect: SpatialTargetRect = readStageRect(container);
      const usesExhibitionPortraitCamera = () =>
        isExhibitionMode &&
        window.matchMedia(
          '(orientation: portrait) and (min-width: 600px)',
        ).matches;

      const resize = () => {
        stageRect = readStageRect(container);
        const width = Math.max(container.clientWidth, 1);
        const height = Math.max(container.clientHeight, 1);
        renderer.setSize(width, height, false);
        if (loadedVrm) {
          frameAvatar(
            loadedVrm,
            camera,
            width,
            height,
            usesExhibitionPortraitCamera()
              ? EXHIBITION_PORTRAIT_CAMERA
              : STAGE_PRESET.camera,
          );
        }
      };
      const resizeObserver = new ResizeObserver(resize);
      const handleWindowScroll = () => {
        stageRect = readStageRect(container);
      };
      window.addEventListener('scroll', handleWindowScroll, true);
      resizeObserver.observe(container);
      resize();

      const loader = new GLTFLoader();
      loader.register((parser) => new VRMLoaderPlugin(parser));
      const loadAvatar = async () => {
        try {
          const modelResponse = await fetch(MODEL_URL, { method: 'HEAD' });
          const contentType = modelResponse.headers.get('content-type') ?? '';
          if (!modelResponse.ok || contentType.includes('text/html')) {
            if (!disposed) setLoadState('missing');
            return;
          }
        } catch {
          if (!disposed) setLoadState('error');
          return;
        }

        loader.load(
          MODEL_URL,
          (gltf) => {
            if (disposed) return;
            const vrm = gltf.userData.vrm as VRM | undefined;
            if (!vrm) {
              setLoadState('error');
              return;
            }

            VRMUtils.rotateVRM0(vrm);
            const initialBounds = new Box3().setFromObject(vrm.scene);
            const center = initialBounds.getCenter(new Vector3());
            gazeModelHeight = Math.max(initialBounds.getSize(new Vector3()).y, 0.1);
            vrm.scene.position.set(-center.x, -initialBounds.min.y, -center.z);
            scene.add(vrm.scene);
            loadedVrm = vrm;
            loadedVrmRef.current = vrm;
            applyBasePose(vrm);
            idleController = new IdleController(vrm);
            idleGazeController = new IdleGazeController(
              vrm,
              gazeModelHeight,
            );
            motionPlayerRef.current = lifeDynamicsPocEnabled
              ? null
              : new MotionPlayer(vrm.scene);
            blinkController = lifeDynamicsPocEnabled
              ? null
              : new BlinkController(vrm);
            emotionController = new EmotionExpressionController(vrm);
            if (lifeDynamicsPocEnabled) {
              const lifeDynamics = new LifeDynamics(
                createLifeDynamicsProfile(lifeDynamicsProfileId),
              );
              lifeDynamics.reset(runtimeLifeDynamicsRandom);
              lifeDynamicsRef.current = lifeDynamics;
              lifeDynamicsBlinkAdapterRef.current =
                new LifeDynamicsBlinkAdapter(vrm);
              lifeDynamicsLifeAdapterRef.current =
                new LifeDynamicsLifeAdapter(vrm);
              lifeDynamicsOrientingAdapterRef.current =
                new LifeDynamicsOrientingAdapter(vrm);
              idleController.setEnabled(false);
            } else {
              lifeDynamicsRef.current = null;
              lifeDynamicsBlinkAdapterRef.current = null;
              lifeDynamicsLifeAdapterRef.current = null;
              lifeDynamicsOrientingAdapterRef.current = null;
            }

            const availableExpressions =
              vrm.expressionManager?.expressions.map(
                (candidate) => candidate.expressionName,
              ) ?? [];
            console.info('Performer VRM expressions:', availableExpressions);
            if (emotionController.missingExpressions.length > 0) {
              const missingExpressions =
                emotionController.missingExpressions.join(', ');
              setExpressionWarning((current) =>
                [
                  current,
                  `不足している感情表情は neutral に置き換えます: ${missingExpressions}`,
                ]
                  .filter(Boolean)
                  .join(' '),
              );
            }
            emotionController.setEmotion(
              emotionRef.current,
              performancePlanRef.current?.avatarProfile?.expressionHoldMs ?? 0,
            );
            appliedEmotion = emotionRef.current;

            const expression = vrm.expressionManager?.getExpression(
              VRMExpressionPresetName.Aa,
            );
            if (expression) {
              mouthExpression = VRMExpressionPresetName.Aa;
            } else {
              setExpressionWarning((current) =>
                [
                  current,
                  'この VRM には標準の aa 口形状がありません。モデルは表示できますが、口パクは利用できません。',
                ]
                  .filter(Boolean)
                  .join(' '),
              );
            }

            frameAvatar(
              vrm,
              camera,
              container.clientWidth,
              container.clientHeight,
              usesExhibitionPortraitCamera()
                ? EXHIBITION_PORTRAIT_CAMERA
                : STAGE_PRESET.camera,
            );
            setLoadState('ready');
            onReadyRef.current?.();
            void syncMotionAsset();
          },
          undefined,
          () => {
            if (!disposed) setLoadState('error');
          },
        );
      };
      void loadAvatar();

      const clock = new Clock();
      const render = () => {
        if (disposed) return;
        const delta = clock.getDelta();
        if (loadedVrm) {
          const plan = performancePlanRef.current;
          const performanceState = performanceStateRef.current;
          const activePerformancePlan = performanceState?.plan ?? plan;
          const avatarProfile = activePerformancePlan?.avatarProfile;
          const preReaction = activePerformancePlan?.preReaction;
          const listeningReactionState = listeningReactionRef.current;
          const hasPerformanceState =
            performanceState !== null || plan !== null;
          const attention = attentionReaderRef.current();
          const thinking =
            listeningReactionState?.kind === 'thinking' ||
            (performanceState?.phase === 'pre_reaction' &&
              activePerformancePlan?.intent === 'speak');
          const viewerEngaged =
            listeningReactionState?.target === 'viewer' ||
            (hasPerformanceState &&
              activePerformancePlan?.preReaction?.gaze?.target === 'viewer' &&
              !thinking);
          const cameraEnabled =
            attention.position !== null || attention.confidence > 0;
          const cameraTracking = cameraTrackingController.update({
            now: performance.now(),
            enabled: cameraEnabled,
            snapshot: {
              position: attention.position,
              confidence: attention.confidence,
              updatedAt: attention.updatedAt,
            },
          });
          const attentionFrame = attentionStateController.update({
            now: performance.now(),
            attention,
            explicitTargetActive:
              attention.targetMode !== 'task-cue' &&
              (attention.target === 'game' ||
                (hasPerformanceState && attention.target === 'chat')),
            viewerEngaged,
            thinking,
            cameraEnabled,
            cameraTracking,
          });
          const attentionEngagement = attentionEngagementController.update(
            delta,
            {
              state: attentionFrame.state,
              viewerEngaged,
              hasCameraPosition: attentionFrame.position !== null,
            },
          );
          const visualAttention = attentionVisualSmoother.update(delta, {
            eyePosition:
              attentionFrame.state === 'AttendViewer'
                ? attentionFrame.position
                : null,
            headPosition:
              attentionFrame.state === 'AttendViewer'
                ? attentionFrame.headPosition
                : null,
          });
          let cameraHeadYawBias = 0;
          let cameraHeadPitchBias = 0;
          if (
            attentionFrame.state === 'AttendViewer' &&
            visualAttention.headPosition
          ) {
            const headBias = mapCameraAttentionToHeadBias(
              visualAttention.headPosition,
              camera.fov,
              camera.aspect,
              attentionEngagement,
            );
            cameraHeadYawBias = headBias.yawDegrees;
            cameraHeadPitchBias = headBias.pitchDegrees;
          }
          const safeMotionScale = Math.max(
            0,
            Math.min(motionScaleRef.current, 1),
          );
          const requestedIdleMotionWeight =
            avatarProfile?.idleMotionWeight ?? preReaction?.motion?.weight ?? 1;
          const idleMotionWeight =
            1 + (requestedIdleMotionWeight - 1) * safeMotionScale;
          const listeningNodDegrees =
            listeningReactionState?.kind === 'nod'
              ? getListeningNodDegrees(
                  (performance.now() - listeningReactionStartedAtRef.current) /
                    1_000,
                )
              : 0;
          const motionPlayer = motionPlayerRef.current;
          idleController?.removeOverlay();
          lifeDynamicsLifeAdapterRef.current?.reset();
          lifeDynamicsOrientingAdapterRef.current?.reset();
          motionPlayer?.update(delta);
          loadedVrm.scene.updateMatrixWorld(true);
          const playbackState = motionPlayer?.playbackState ?? 'idle';
          const hasActiveBodyMotion =
            playbackState === 'entering' ||
            playbackState === 'playing' ||
            playbackState === 'exiting';
          idleGazeController?.getNeutralTarget(lifeDynamicsNeutralTarget);
          let spatialHeadYawBias = 0;
          let spatialHeadPitchBias = 0;
          let resolvedSpatialTargetKey: string | null = null;
          let performanceGazeTarget: Vector3 | null = null;
          let softCueWorldTarget: Vector3 | null = null;
          let softCueSource: string | null = null;
          let hasPrimarySpatialTarget = false;
          const attentionEnergy =
            attention.softCue?.strength ??
            attention.priorityHint?.gazeStrength ??
            attention.gazeStrength ??
            (attentionFrame.target === 'none'
              ? ATTENTION_ENERGY_CONFIG.normalBaseline
              : attentionFrame.gazeStrength);
          let spatialTargetDebug: SpatialTargetDebugSnapshot = {
            primarySource:
              attentionFrame.target === 'viewer'
                ? 'viewer'
                : attentionFrame.target === 'none'
                  ? 'none'
                  : `${attentionFrame.target}:default`,
            primaryWorld: null,
            attentionMode: attention.targetMode ?? 'semantic',
            attentionEnergy,
            softCueSource: null,
            softCueWorld: null,
            headProjection: { yawDegrees: 0, pitchDegrees: 0 },
            valid: false,
            owner:
              attentionFrame.target === 'none'
                ? 'none'
                : attentionFrame.target,
            releaseReason:
              attentionFrame.target === 'none' ? 'released' : 'none',
            gazeStrength: attentionFrame.gazeStrength,
          };
          const hasSpatialHint =
            attention.priorityHint?.spatialTarget?.kind === 'game' ||
            attention.priorityHint?.spatialTarget?.kind === 'chat' ||
            attentionFrame.softCue?.spatialTarget.kind === 'game' ||
            attentionFrame.softCue?.spatialTarget.kind === 'chat';
          const hasSpatialOwnership =
            attentionFrame.target === 'game' ||
            attentionFrame.target === 'chat' ||
            hasSpatialHint;
          if (!hasSpatialOwnership) {
            spatialTargetWorldCache.clear();
          }
          if (attentionFrame.state === 'Thinking') {
            idleGazeController?.getNeutralTarget(thinkingGazeTarget);
            thinkingGazeTarget.x += gazeModelHeight * 0.035;
            thinkingGazeTarget.y += gazeModelHeight * 0.018;
            performanceGazeTarget = thinkingGazeTarget;
            spatialTargetDebug = {
              primarySource: 'thinking',
              primaryWorld: toDebugWorld(performanceGazeTarget),
              attentionMode: attention.targetMode ?? 'semantic',
              attentionEnergy,
              softCueSource: null,
              softCueWorld: null,
              headProjection: { yawDegrees: 0, pitchDegrees: 0 },
              valid: true,
              owner: 'none',
              releaseReason: 'none',
              gazeStrength: attentionFrame.gazeStrength,
            };
          } else if (attentionFrame.state === 'AttendViewer') {
            if (visualAttention.eyePosition && loadedVrm.lookAt) {
              camera.updateMatrixWorld(true);
              loadedVrm.lookAt.getLookAtWorldPosition(lookAtWorldPosition);
              camera.getWorldDirection(viewerCameraForward);
              viewerCameraRight
                .setFromMatrixColumn(camera.matrixWorld, 0)
                .normalize();
              viewerCameraUp
                .setFromMatrixColumn(camera.matrixWorld, 1)
                .normalize();
              performanceGazeTarget = mapCameraAttentionToViewerTarget(
                {
                  position: camera.position,
                  forward: viewerCameraForward,
                  right: viewerCameraRight,
                  up: viewerCameraUp,
                },
                lookAtWorldPosition,
                visualAttention.eyePosition,
                camera.fov,
                camera.aspect,
                viewerGazeTarget,
              );
            } else if (viewerEngaged) {
              performanceGazeTarget = camera.position;
            }
            spatialTargetDebug = {
              primarySource: 'viewer',
              primaryWorld: toDebugWorld(performanceGazeTarget),
              attentionMode: attention.targetMode ?? 'semantic',
              attentionEnergy,
              softCueSource: null,
              softCueWorld: null,
              headProjection: { yawDegrees: 0, pitchDegrees: 0 },
              valid: performanceGazeTarget !== null,
              owner: 'viewer',
              releaseReason:
                performanceGazeTarget === null ? 'camera-invalid' : 'none',
              gazeStrength: attentionFrame.gazeStrength,
            };
          } else if (attentionFrame.state === 'AttendTarget') {
            const spatialSelection: SpatialTargetSelection | null =
              attentionFrame.target === 'game' ||
              attentionFrame.target === 'chat'
                ? attentionFrame.spatialTarget?.kind === attentionFrame.target
                  ? attentionFrame.spatialTarget
                  : { kind: attentionFrame.target, anchor: 'default' }
                : null;
            if (spatialSelection) {
              hasPrimarySpatialTarget = true;
              const requestedSpatialTargetKey = formatSpatialTargetSelection(
                spatialSelection,
              );
              resolvedSpatialTargetKey = requestedSpatialTargetKey;
              camera.updateMatrixWorld(true);
              if (loadedVrm.lookAt) {
                loadedVrm.lookAt.getLookAtWorldPosition(lookAtWorldPosition);
              } else {
                lookAtWorldPosition.copy(lifeDynamicsNeutralTarget);
              }
              const spatialLookup = spatialTargetRegistry?.resolveWithStatus(
                spatialSelection,
                performance.now(),
              );
              const spatialSnapshot = spatialLookup?.snapshot ?? null;
              const spatialResolution = spatialSnapshot
                ? spatialTargetBridge.resolve({
                    camera,
                    eyePosition: lookAtWorldPosition,
                    neutralTarget: lifeDynamicsNeutralTarget,
                    snapshot: spatialSnapshot,
                    stageRect,
                  })
                : null;
              if (spatialTargetRegistry) {
                const resolvedSpatialTargetKeyFromSnapshot =
                  formatSpatialTargetSelection(
                    spatialSnapshot?.selection ?? spatialSelection,
                  );
                resolvedSpatialTargetKey =
                  resolvedSpatialTargetKeyFromSnapshot;
                const worldResolution = spatialTargetWorldCache.resolve({
                  key: resolvedSpatialTargetKeyFromSnapshot,
                  now: performance.now(),
                  live: spatialResolution,
                  liveValid:
                    spatialLookup?.valid === true &&
                    spatialResolution !== null,
                  liveReason: spatialLookup?.reason ?? 'missing',
                  invalidSince: spatialLookup?.invalidSince ?? null,
                });
                performanceGazeTarget = worldResolution.target;
                spatialHeadYawBias = worldResolution.headProjection.yawDegrees;
                spatialHeadPitchBias =
                  worldResolution.headProjection.pitchDegrees;
                spatialTargetDebug = {
                  primarySource: resolvedSpatialTargetKeyFromSnapshot,
                  primaryWorld: toDebugWorld(worldResolution.target),
                  attentionMode: attention.targetMode ?? 'semantic',
                  attentionEnergy,
                  softCueSource: null,
                  softCueWorld: null,
                  headProjection: {
                    yawDegrees: spatialHeadYawBias,
                    pitchDegrees: spatialHeadPitchBias,
                  },
                  valid: worldResolution.valid,
                  owner: attentionFrame.target,
                  releaseReason:
                    spatialSnapshot === null
                      ? spatialLookup?.reason ?? 'registry-unavailable'
                      : spatialResolution === null
                        ? 'bridge-invalid'
                        : worldResolution.reason,
                  gazeStrength: attentionFrame.gazeStrength,
                };
              } else {
                performanceGazeTarget = lifeDynamicsNeutralTarget;
                spatialTargetDebug = {
                  primarySource: requestedSpatialTargetKey,
                  primaryWorld: null,
                  attentionMode: attention.targetMode ?? 'semantic',
                  attentionEnergy,
                  softCueSource: null,
                  softCueWorld: null,
                  headProjection: { yawDegrees: 0, pitchDegrees: 0 },
                  valid: false,
                  owner: attentionFrame.target,
                  releaseReason: 'registry-unavailable',
                  gazeStrength: attentionFrame.gazeStrength,
                };
              }
            } else {
              performanceGazeTarget = null;
            }
          }

          const softCueSelection = attentionFrame.softCue?.spatialTarget;
          if (
            softCueSelection &&
            (softCueSelection.kind === 'game' ||
              softCueSelection.kind === 'chat') &&
            spatialTargetRegistry
          ) {
            camera.updateMatrixWorld(true);
            if (loadedVrm.lookAt) {
              loadedVrm.lookAt.getLookAtWorldPosition(lookAtWorldPosition);
            } else {
              lookAtWorldPosition.copy(lifeDynamicsNeutralTarget);
            }
            const softCueLookup = spatialTargetRegistry.resolveWithStatus(
              softCueSelection,
              performance.now(),
            );
            const softCueSnapshot = softCueLookup.snapshot;
            const softCueResolution = softCueSnapshot
              ? spatialTargetBridge.resolve({
                  camera,
                  eyePosition: lookAtWorldPosition,
                  neutralTarget: lifeDynamicsNeutralTarget,
                  snapshot: softCueSnapshot,
                  stageRect,
                })
              : null;
            const softCueResolvedKey = formatSpatialTargetSelection(
              softCueSnapshot?.selection ?? softCueSelection,
            );
            const softCueWorldResolution = spatialTargetWorldCache.resolve({
              key: softCueResolvedKey,
              now: performance.now(),
              live: softCueResolution,
              liveValid:
                softCueLookup.valid === true && softCueResolution !== null,
              liveReason: softCueLookup.reason ?? 'missing',
              invalidSince: softCueLookup.invalidSince ?? null,
            });
            softCueSource = softCueResolvedKey;
            softCueWorldTarget = softCueWorldResolution.target;
          }

          spatialTargetDebug = {
            ...spatialTargetDebug,
            softCueSource,
            softCueWorld: toDebugWorld(softCueWorldTarget),
          };
          const gazeStrength = attentionFrame.gazeStrength;
          const primaryOutputTarget =
            performanceGazeTarget === null
              ? null
              : blendGazeTarget(
                  lifeDynamicsNeutralTarget,
                  performanceGazeTarget,
                  gazeStrength,
                  primaryGazeOutputTarget,
                );
          const softCueApplies =
            softCueWorldTarget !== null &&
            attentionFrame.softCue !== undefined &&
            attentionFrame.softCue.target !== attentionFrame.target;
          let gazeOutputTarget: Vector3 | null = null;
          if (primaryOutputTarget !== null || softCueApplies) {
            if (primaryOutputTarget !== null) {
              gazeOutputTargetVector.copy(primaryOutputTarget);
            } else {
              gazeOutputTargetVector.copy(lifeDynamicsNeutralTarget);
            }
            if (softCueApplies) {
              gazeOutputTargetVector.lerp(
                softCueWorldTarget!,
                clampGazeStrength(attentionFrame.softCue?.strength ?? 0),
              );
            }
            if (hasPrimarySpatialTarget) {
              gazeOutputTarget = spatialEyeSmoother.update(
                gazeOutputTargetVector,
                delta,
                SPATIAL_TARGET_OUTPUT_TIMING.eyeResponseMs,
                gazeOutputTargetVector,
              );
            } else {
              spatialEyeSmoother.reset(lifeDynamicsNeutralTarget);
              gazeOutputTarget = gazeOutputTargetVector;
            }
          } else {
            spatialEyeSmoother.reset(lifeDynamicsNeutralTarget);
          }
          const smoothedSpatialHeadProjection = hasPrimarySpatialTarget
            ? spatialHeadSmoother.update(
                {
                  yawDegrees: spatialHeadYawBias,
                  pitchDegrees: spatialHeadPitchBias,
                },
                delta,
                SPATIAL_TARGET_OUTPUT_TIMING.headResponseMs,
              )
            : (spatialHeadSmoother.reset(), {
                yawDegrees: 0,
                pitchDegrees: 0,
              });
          const effectiveSpatialHeadYawBias =
            smoothedSpatialHeadProjection.yawDegrees;
          const effectiveSpatialHeadPitchBias =
            smoothedSpatialHeadProjection.pitchDegrees;
          const gazeDirectness =
            avatarProfile?.gazeDirectness ??
            preReaction?.gaze?.directness ??
            0.72;
          const requestedHeadYawBias =
            (avatarProfile?.headYawBias ??
              preReaction?.motion?.headYawBias ??
              0) +
            (attentionFrame.target === 'viewer' && !loadedVrm.lookAt
              ? 0.6
              : effectiveSpatialHeadYawBias) * gazeDirectness;
          const headYawBias = requestedHeadYawBias * safeMotionScale;
          const headPitchBias =
            (listeningNodDegrees +
              effectiveSpatialHeadPitchBias * gazeDirectness) *
            safeMotionScale;
          let lifeDynamicsSnapshot: LifeDynamicsSnapshot | null = null;
          if (lifeDynamicsPocEnabled) {
            const attentionTarget =
              attentionFrame.target === 'none'
                ? null
                : attentionFrame.target;
            const attentionLevel =
              attentionTarget === null
                ? 0
                : Math.max(attentionFrame.strength, attentionEngagement);
            const attentionTargetKey =
              attentionTarget === null
                ? null
                : attentionTarget === 'game' || attentionTarget === 'chat'
                  ? resolvedSpatialTargetKey ??
                    `${attentionTarget}:${attentionFrame.spatialTarget?.anchor ?? attention.spatialTarget?.anchor ?? 'default'}`
                  : attentionTarget;
            const behaviorEnergy = activePerformancePlan?.behavior?.energy;
            const lifeDynamicsInputs: LifeDynamicsInputs = {
              arousal: attentionLevel,
              curiosity:
                attentionFrame.state === 'Thinking'
                  ? Math.max(attentionFrame.strength, attentionEngagement)
                  : 0,
              attention:
                attentionTarget === null
                  ? {}
                  : { [attentionTarget]: attentionLevel },
              attentionTarget,
              attentionTargetKey,
              speechUrge:
                activePerformancePlan?.intent === 'speak' ? 1 : 0,
              inhibition: hasActiveBodyMotion ? 1 : thinking ? 0.5 : 0,
              energy:
                behaviorEnergy === 'high'
                  ? 1
                  : behaviorEnergy === 'low'
                    ? 0.3
                    : 0.6,
              emotion: emotionRef.current,
              intent: activePerformancePlan?.intent ?? null,
              gestureIntent:
                activePerformancePlan?.behavior?.gestureIntent ?? null,
              gestureTrigger:
                activePerformancePlan?.behavior?.gestureIntent !== undefined &&
                performanceState?.phase === 'pre_reaction',
            };
            lifeDynamicsSnapshot =
              lifeDynamicsRef.current?.update(
                delta,
                lifeDynamicsInputs,
                runtimeLifeDynamicsRandom,
              ) ?? null;
            if (lifeDynamicsSnapshot && lifeDynamicsDebugEnabled) {
              const now = performance.now();
              if (now - lifeDynamicsDebugLastLogAtRef.current >= 250) {
                setLifeDynamicsDebugSnapshot(lifeDynamicsSnapshot);
                setSpatialTargetDebugSnapshot(spatialTargetDebug);
                console.debug('[life-dynamics]', {
                  profile: lifeDynamicsSnapshot.profileId,
                  attentionTarget: lifeDynamicsSnapshot.orienting.target,
                  orientingPhase: lifeDynamicsSnapshot.orienting.phase,
                  headWeight: lifeDynamicsSnapshot.orienting.headWeight,
                  blinkState: lifeDynamicsSnapshot.blink.state,
                  gesturePhase: lifeDynamicsSnapshot.gesture.phase,
                  inhibition: lifeDynamicsSnapshot.signals.inhibition,
                  energy: lifeDynamicsSnapshot.modulation.energy,
                  posturalDrift: lifeDynamicsSnapshot.life.posturalDrift,
                  asymmetry: lifeDynamicsSnapshot.life.asymmetry,
                  breathModulation:
                    lifeDynamicsSnapshot.life.breathModulation,
                  primarySource: spatialTargetDebug.primarySource,
                  primaryWorld: spatialTargetDebug.primaryWorld,
                  spatialValid: spatialTargetDebug.valid,
                  attentionMode: spatialTargetDebug.attentionMode,
                  attentionEnergy: spatialTargetDebug.attentionEnergy,
                  softCueSource: spatialTargetDebug.softCueSource,
                  softCueWorld: spatialTargetDebug.softCueWorld,
                  headProjection: spatialTargetDebug.headProjection,
                  targetOwner: spatialTargetDebug.owner,
                  releaseReason: spatialTargetDebug.releaseReason,
                  gazeStrength: spatialTargetDebug.gazeStrength,
                });
                lifeDynamicsDebugLastLogAtRef.current = now;
              }
            }
            if (lifeDynamicsSnapshot) {
              lifeDynamicsBlinkAdapterRef.current?.apply(
                lifeDynamicsSnapshot,
              );
              if (!hasActiveBodyMotion) {
                lifeDynamicsLifeAdapterRef.current?.apply(
                  lifeDynamicsSnapshot,
                );
              }
              lifeDynamicsOrientingAdapterRef.current?.apply({
                snapshot: lifeDynamicsSnapshot,
                neutralTarget: lifeDynamicsNeutralTarget,
                desiredTarget: gazeOutputTarget,
                headBias: {
                  yawDegrees: headYawBias + cameraHeadYawBias,
                  pitchDegrees: headPitchBias + cameraHeadPitchBias,
                },
                vrmaActive: hasActiveBodyMotion,
              });
            }
          }
          if (!lifeDynamicsPocEnabled) {
            const idleGazeFrame = idleGazeController?.update(
              delta,
              camera.position,
              !hasActiveBodyMotion &&
                !hasPerformanceState &&
                attentionFrame.state === 'Idle',
              gazeOutputTarget,
            );
            idleController?.setEnabled(true);
            if (hasActiveBodyMotion) {
              idleController?.updateOverlay(
                delta,
                idleMotionWeight,
                headYawBias +
                  cameraHeadYawBias +
                  (idleGazeFrame?.fallbackHeadYawBias ?? 0),
                headPitchBias + cameraHeadPitchBias,
              );
            } else {
              idleController?.update(
                delta,
                idleMotionWeight,
                headYawBias +
                  cameraHeadYawBias +
                  (idleGazeFrame?.fallbackHeadYawBias ?? 0),
                headPitchBias + cameraHeadPitchBias,
              );
            }
          }
          if (emotionController && appliedEmotion !== emotionRef.current) {
            emotionController.setEmotion(
              emotionRef.current,
              avatarProfile?.expressionHoldMs ?? 0,
            );
            appliedEmotion = emotionRef.current;
          }
          emotionController?.update(delta);
          if (!lifeDynamicsPocEnabled) {
            blinkController?.update(delta);
          }
          if (mouthExpression) {
            loadedVrm.expressionManager?.setValue(
              mouthExpression,
              mouthOpenRef.current,
            );
          }
          loadedVrm.expressionManager?.update();
          loadedVrm.update(delta);

          const currentPerformanceState = performanceStateRef.current;
          const recoveryStartedAt =
            currentPerformanceState?.recoveryStartedAt;
          const motionRecovered =
            playbackState === 'idle' || playbackState === 'settled';
          if (
            currentPerformanceState?.phase === 'recovery' &&
            recoveryStartedAt !== null &&
            recoveryStartedAt !== undefined &&
            !performancePlanRef.current &&
            !listeningReactionRef.current &&
            motionRecovered &&
            performance.now() - recoveryStartedAt >=
              currentPerformanceState.plan.timing.motionExitBlendMs
          ) {
            performanceStateRef.current = null;
          }
        }
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(render);
      };
      animationFrame = requestAnimationFrame(render);

      return () => {
        disposed = true;
        cancelAnimationFrame(animationFrame);
        resizeObserver.disconnect();
        window.removeEventListener('scroll', handleWindowScroll, true);
        blinkController?.dispose();
        emotionController?.dispose();
        attentionEngagementController.reset();
        spatialEyeSmoother.reset();
        spatialHeadSmoother.reset();
        idleController?.dispose();
        idleGazeController?.dispose();
        lifeDynamicsLifeAdapterRef.current?.dispose();
        lifeDynamicsOrientingAdapterRef.current?.dispose();
        lifeDynamicsBlinkAdapterRef.current?.dispose();
        spatialTargetWorldCache.clear();
        blinkController = null;
        emotionController = null;
        idleController = null;
        idleGazeController = null;
        lifeDynamicsLifeAdapterRef.current = null;
        lifeDynamicsOrientingAdapterRef.current = null;
        lifeDynamicsBlinkAdapterRef.current = null;
        lifeDynamicsRef.current = null;
        setLifeDynamicsDebugSnapshot(null);
        setSpatialTargetDebugSnapshot(null);
        stopReactionMotion();
        stopMotion();
        motionPlayerRef.current?.dispose();
        motionPlayerRef.current = null;
        loadedVrmRef.current = null;
        if (loadedVrm) {
          scene.remove(loadedVrm.scene);
          VRMUtils.deepDispose(loadedVrm.scene);
        }
        renderer.dispose();
      };
    }, [
      isExhibitionMode,
      lifeDynamicsDebugEnabled,
      lifeDynamicsPocEnabled,
      lifeDynamicsProfileId,
      spatialTargetRegistry,
      stageVariant,
      stopMotion,
      stopReactionMotion,
      syncMotionAsset,
    ]);

    return (
      <div className="vrm-stage" ref={containerRef}>
        <canvas
          aria-label="Performer avatar"
          className="vrm-canvas"
          ref={canvasRef}
        />
        {lifeDynamicsPocEnabled &&
          lifeDynamicsDebugEnabled &&
          lifeDynamicsDebugSnapshot && (
            <aside
              aria-label="LifeDynamics debug"
              className="life-dynamics-debug"
            >
              <strong>LifeDynamics {lifeDynamicsDebugSnapshot.profileId}</strong>
              <span>
                target: {lifeDynamicsDebugSnapshot.orienting.target ?? 'none'}
              </span>
              {spatialTargetDebugSnapshot && (
                <>
                  <span>
                    primary source: {spatialTargetDebugSnapshot.primarySource}
                  </span>
                  <span>
                    primary world:{' '}
                    {spatialTargetDebugSnapshot.primaryWorld === null
                      ? 'none'
                      : `${spatialTargetDebugSnapshot.primaryWorld.x.toFixed(2)},${spatialTargetDebugSnapshot.primaryWorld.y.toFixed(2)},${spatialTargetDebugSnapshot.primaryWorld.z.toFixed(2)}`}
                  </span>
                  <span>
                    mode: {spatialTargetDebugSnapshot.attentionMode}
                  </span>
                  <span>
                    energy: {spatialTargetDebugSnapshot.attentionEnergy.toFixed(2)}
                  </span>
                  <span>
                    soft: {spatialTargetDebugSnapshot.softCueSource ?? 'none'}
                  </span>
                  <span>
                    soft world:{' '}
                    {spatialTargetDebugSnapshot.softCueWorld === null
                      ? 'none'
                      : `${spatialTargetDebugSnapshot.softCueWorld.x.toFixed(2)},${spatialTargetDebugSnapshot.softCueWorld.y.toFixed(2)},${spatialTargetDebugSnapshot.softCueWorld.z.toFixed(2)}`}
                  </span>
                  <span>
                    head projection:{' '}
                    {spatialTargetDebugSnapshot.headProjection.yawDegrees.toFixed(2)},
                    {spatialTargetDebugSnapshot.headProjection.pitchDegrees.toFixed(2)}
                  </span>
                  <span>
                    valid: {String(spatialTargetDebugSnapshot.valid)}
                  </span>
                  <span>
                    gaze: {spatialTargetDebugSnapshot.gazeStrength.toFixed(2)}
                  </span>
                  <span>owner: {spatialTargetDebugSnapshot.owner}</span>
                  <span>
                    release: {spatialTargetDebugSnapshot.releaseReason}
                  </span>
                </>
              )}
              <span>
                orienting: {lifeDynamicsDebugSnapshot.orienting.phase}
              </span>
              <span>
                head: {lifeDynamicsDebugSnapshot.orienting.headWeight.toFixed(2)}
              </span>
              <span>blink: {lifeDynamicsDebugSnapshot.blink.state}</span>
              <span>
                gesture: {lifeDynamicsDebugSnapshot.gesture.phase}
              </span>
              <span>
                inhibition: {lifeDynamicsDebugSnapshot.signals.inhibition.toFixed(2)}
              </span>
              <span>
                energy: {lifeDynamicsDebugSnapshot.modulation.energy.toFixed(2)}
              </span>
              <span>
                life phase: b {lifeDynamicsDebugSnapshot.life.breathingPhase.toFixed(2)} / s {lifeDynamicsDebugSnapshot.life.swayPhase.toFixed(2)}
              </span>
              <span>
                drift: {lifeDynamicsDebugSnapshot.life.posturalDrift.toFixed(2)}
              </span>
              <span>
                asym: {lifeDynamicsDebugSnapshot.life.asymmetry.toFixed(2)}
              </span>
              <span>
                breath mod: {lifeDynamicsDebugSnapshot.life.breathModulation.toFixed(2)}
              </span>
            </aside>
          )}
        {loadState === 'loading' && (
          <p className="stage-message" role="status">
            VRM を読み込んでいます…
          </p>
        )}
        {loadState === 'missing' && (
          <div className="stage-message stage-message--action" role="status">
            <strong>VRM がまだありません。</strong>
            <span>
              <code>public/avatar/model.vrm</code> に配置して、再読み込みしてください。
            </span>
          </div>
        )}
        {loadState === 'error' && (
          <div className="stage-message stage-message--error" role="alert">
            <strong>VRM を表示できませんでした。</strong>
            <span>WebGL と model.vrm の形式を確認してください。</span>
          </div>
        )}
        {expressionWarning && (
          <p className="expression-warning" role="status">
            {expressionWarning}
          </p>
        )}
      </div>
    );
  },
);
