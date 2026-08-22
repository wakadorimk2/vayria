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
import { EmotionExpressionController } from './EmotionExpressionController';
import { IdleGazeController } from './idleGaze';
import { applyBasePose, IdleController } from './idleMotion';
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
import type { PerformancePlan } from '../performer/types';
import type { ListeningReactionCue } from '../voice/voiceInput';

const MODEL_URL = `${import.meta.env.BASE_URL}avatar/model.vrm`;

const LISTENING_NOD_DURATION_SECONDS = 0.48;
const LISTENING_NOD_DEGREES = -4;

function getListeningNodDegrees(elapsedSeconds: number): number {
  if (elapsedSeconds < 0 || elapsedSeconds >= LISTENING_NOD_DURATION_SECONDS) {
    return 0;
  }
  const progress = elapsedSeconds / LISTENING_NOD_DURATION_SECONDS;
  return LISTENING_NOD_DEGREES * Math.sin(progress * Math.PI);
}

interface VrmStageProps {
  attentionTarget?: 'viewer' | 'chat' | 'game' | 'none';
  emotion: Emotion;
  isExhibitionMode?: boolean;
  listeningReaction?: ListeningReactionCue;
  motionScale?: number;
  mouthOpen: number;
  onReady?: () => void;
  performancePlan?: PerformancePlan;
  sessionGeneration?: number;
  stageVariant?: 'default' | 'card-preview';
}

export interface VrmStageHandle {
  prepareMotion(
    plan: PerformancePlan,
    signal?: AbortSignal,
  ): Promise<boolean>;
  startPreparedMotion(planId: string): number | null;
  finishMotion(planId?: string): void;
  stopMotion(planId?: string): void;
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

export const VrmStage = forwardRef<VrmStageHandle, VrmStageProps>(
  function VrmStage(
    {
      attentionTarget = 'none',
      emotion,
      isExhibitionMode = false,
      listeningReaction,
      motionScale = 1,
      mouthOpen,
      onReady,
      performancePlan,
      sessionGeneration = 0,
      stageVariant = 'default',
    },
    ref,
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const mouthOpenRef = useRef(mouthOpen);
    const emotionRef = useRef(emotion);
    const attentionTargetRef = useRef(attentionTarget);
    const listeningReactionRef = useRef(listeningReaction);
    const listeningReactionIdRef = useRef<number | null>(
      listeningReaction?.id ?? null,
    );
    const listeningReactionStartedAtRef = useRef(0);
    const motionScaleRef = useRef(motionScale);
    const performancePlanRef = useRef(performancePlan);
    const onReadyRef = useRef(onReady);
    const [loadState, setLoadState] = useState<LoadState>('loading');
    const [expressionWarning, setExpressionWarning] = useState('');
    const loadedVrmRef = useRef<VRM | null>(null);
    const motionPlayerRef = useRef<MotionPlayer | null>(null);
    const motionCatalogRef = useRef(new SavedMotionCatalog());
    const motionAbortControllerRef = useRef<AbortController | null>(null);
    const motionRequestGenerationRef = useRef(0);
    const preparedMotionPlanIdRef = useRef<string | null>(null);
    const preparedMotionPromiseRef = useRef<{
      planId: string;
      promise: Promise<boolean>;
    } | null>(null);
    const activeMotionPlanIdRef = useRef<string | null>(null);

    useEffect(() => {
      mouthOpenRef.current = mouthOpen;
    }, [mouthOpen]);

    useEffect(() => {
      emotionRef.current = emotion;
    }, [emotion]);

    useEffect(() => {
      attentionTargetRef.current = attentionTarget;
    }, [attentionTarget]);

    useEffect(() => {
      const nextId = listeningReaction?.id ?? null;
      if (nextId !== listeningReactionIdRef.current) {
        listeningReactionIdRef.current = nextId;
        listeningReactionStartedAtRef.current =
          nextId === null ? 0 : performance.now();
      }
      listeningReactionRef.current = listeningReaction;
    }, [listeningReaction]);

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

        if (preparedMotionPromiseRef.current?.planId === plan.planId) {
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

        preparedMotionPromiseRef.current = { planId: plan.planId, promise };
        return promise;
      },
      [],
    );

    const stopMotion = useCallback((planId?: string) => {
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
    }, []);

    const finishMotion = useCallback((planId?: string) => {
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
        startPreparedMotion(planId) {
          if (preparedMotionPlanIdRef.current !== planId) return null;
          const player = motionPlayerRef.current;
          if (!player?.startPrepared()) return null;
          preparedMotionPlanIdRef.current = null;
          activeMotionPlanIdRef.current = planId;
          return performance.now();
        },
        finishMotion,
        stopMotion,
      }),
      [finishMotion, prepareMotion, stopMotion],
    );

    useEffect(() => {
      motionScaleRef.current = motionScale;
      if (motionScale <= 0) {
        stopMotion();
        return;
      }

      const plan = performancePlanRef.current;
      if (plan?.motion) void prepareMotion(plan);
    }, [motionScale, prepareMotion, stopMotion]);

    useEffect(() => {
      const previousPlanId = performancePlanRef.current?.planId;
      performancePlanRef.current = performancePlan;
      const isGracefulExit =
        !performancePlan &&
        activeMotionPlanIdRef.current === previousPlanId &&
        (motionPlayerRef.current?.playbackState === 'exiting' ||
          motionPlayerRef.current?.playbackState === 'settled');
      if (performancePlan?.motion && motionScaleRef.current > 0) {
        void prepareMotion(performancePlan);
      } else if (!isGracefulExit) {
        stopMotion();
      }
    }, [performancePlan, prepareMotion, stopMotion]);

    useEffect(() => {
      if (sessionGeneration === 0) return;
      stopMotion();
    }, [sessionGeneration, stopMotion]);

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
      let blinkController: BlinkController | null = null;
      let emotionController: EmotionExpressionController | null = null;
      let appliedEmotion: Emotion | null = null;
      const usesExhibitionPortraitCamera = () =>
        isExhibitionMode &&
        window.matchMedia(
          '(orientation: portrait) and (min-width: 600px)',
        ).matches;

      const resize = () => {
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
            vrm.scene.position.set(-center.x, -initialBounds.min.y, -center.z);
            scene.add(vrm.scene);
            loadedVrm = vrm;
            loadedVrmRef.current = vrm;
            applyBasePose(vrm);
            idleController = new IdleController(vrm);
            idleGazeController = new IdleGazeController(
              vrm,
              initialBounds.getSize(new Vector3()).y,
            );
            motionPlayerRef.current = new MotionPlayer(vrm.scene);
            blinkController = new BlinkController(vrm);
            emotionController = new EmotionExpressionController(vrm);

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
            emotionController.setEmotion(emotionRef.current);
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
          const avatarProfile = plan?.avatarProfile;
          const preReaction = plan?.preReaction;
          const listeningReactionState = listeningReactionRef.current;
          const safeMotionScale = Math.max(
            0,
            Math.min(motionScaleRef.current, 1),
          );
          const gazeTarget =
            listeningReactionState?.target ??
            preReaction?.gaze?.target ??
            attentionTargetRef.current;
          const gazeYawBias =
            gazeTarget === 'viewer'
              ? 0.6
              : gazeTarget === 'chat'
                ? -0.45
                : gazeTarget === 'game'
                  ? 0.35
                  : 0;
          const requestedIdleMotionWeight =
            avatarProfile?.idleMotionWeight ?? preReaction?.motion?.weight ?? 1;
          const idleMotionWeight =
            1 + (requestedIdleMotionWeight - 1) * safeMotionScale;
          const requestedHeadYawBias =
            (avatarProfile?.headYawBias ??
              preReaction?.motion?.headYawBias ??
              0) +
            gazeYawBias *
              (avatarProfile?.gazeDirectness ??
                preReaction?.gaze?.directness ??
                0.72);
          const headYawBias = requestedHeadYawBias * safeMotionScale;
          const isBodyMotionPlaying =
            motionPlayerRef.current?.isPlaying() ?? false;
          const listeningNodDegrees = listeningReactionState
            ? getListeningNodDegrees(
                (performance.now() - listeningReactionStartedAtRef.current) /
                  1_000,
              )
            : 0;
          const idleGazeFrame = idleGazeController?.update(
            delta,
            camera.position,
            !isBodyMotionPlaying && !performancePlanRef.current,
          );
          idleController?.setEnabled(!isBodyMotionPlaying);
          if (!isBodyMotionPlaying) {
            idleController?.update(
              delta,
              idleMotionWeight,
              headYawBias + (idleGazeFrame?.fallbackHeadYawBias ?? 0),
              listeningNodDegrees,
            );
          }
          motionPlayerRef.current?.update(delta);
          if (emotionController && appliedEmotion !== emotionRef.current) {
            emotionController.setEmotion(emotionRef.current);
            appliedEmotion = emotionRef.current;
          }
          emotionController?.update(delta);
          blinkController?.update(delta);
          if (mouthExpression) {
            loadedVrm.expressionManager?.setValue(
              mouthExpression,
              mouthOpenRef.current,
            );
          }
          loadedVrm.expressionManager?.update();
          loadedVrm.update(delta);
        }
        renderer.render(scene, camera);
        animationFrame = requestAnimationFrame(render);
      };
      animationFrame = requestAnimationFrame(render);

      return () => {
        disposed = true;
        cancelAnimationFrame(animationFrame);
        resizeObserver.disconnect();
        blinkController?.dispose();
        emotionController?.dispose();
        idleController?.dispose();
        idleGazeController?.dispose();
        blinkController = null;
        emotionController = null;
        idleController = null;
        idleGazeController = null;
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
    }, [isExhibitionMode, stageVariant, stopMotion, syncMotionAsset]);

    return (
      <div className="vrm-stage" ref={containerRef}>
        <canvas
          aria-label="Performer avatar"
          className="vrm-canvas"
          ref={canvasRef}
        />
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
