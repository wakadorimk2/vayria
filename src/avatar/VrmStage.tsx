import { useCallback, useEffect, useRef, useState } from 'react';
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

const MODEL_URL = `${import.meta.env.BASE_URL}avatar/model.vrm`;

interface VrmStageProps {
  attentionTarget?: 'viewer' | 'chat' | 'game' | 'none';
  emotion: Emotion;
  isExhibitionMode?: boolean;
  motionScale?: number;
  mouthOpen: number;
  onReady?: () => void;
  performancePlan?: PerformancePlan;
  sessionGeneration?: number;
  stageVariant?: 'default' | 'card-preview';
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

export function VrmStage({
  attentionTarget = 'none',
  emotion,
  isExhibitionMode = false,
  motionScale = 1,
  mouthOpen,
  onReady,
  performancePlan,
  sessionGeneration = 0,
  stageVariant = 'default',
}: VrmStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouthOpenRef = useRef(mouthOpen);
  const emotionRef = useRef(emotion);
  const attentionTargetRef = useRef(attentionTarget);
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
  const requestedMotionAssetId = performancePlan?.motion?.assetId ?? null;
  const requestedMotionAssetIdRef = useRef<string | null>(
    requestedMotionAssetId,
  );

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
    performancePlanRef.current = performancePlan;
  }, [performancePlan]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  const syncMotionAsset = useCallback(async () => {
    const requestGeneration = ++motionRequestGenerationRef.current;
    motionAbortControllerRef.current?.abort();

    const assetId = requestedMotionAssetIdRef.current;
    const vrm = loadedVrmRef.current;
    const player = motionPlayerRef.current;
    if (!vrm || !player) return;

    if (!assetId || motionScaleRef.current <= 0) {
      player.stop();
      return;
    }

    player.stop();
    const controller = new AbortController();
    motionAbortControllerRef.current = controller;

    try {
      const asset = await motionCatalogRef.current.get(
        assetId,
        controller.signal,
      );
      if (
        requestGeneration !== motionRequestGenerationRef.current ||
        controller.signal.aborted ||
        requestedMotionAssetIdRef.current !== assetId ||
        loadedVrmRef.current !== vrm
      ) {
        return;
      }

      await player.play(asset, vrm, controller.signal);
    } catch (error) {
      if (
        controller.signal.aborted ||
        requestGeneration !== motionRequestGenerationRef.current
      ) {
        return;
      }
      player.stop();
      console.warn('Performer motion fallback: saved asset was not played.', {
        assetId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    motionScaleRef.current = motionScale;
    if (motionScale <= 0) {
      motionRequestGenerationRef.current += 1;
      motionAbortControllerRef.current?.abort();
      motionPlayerRef.current?.stop();
      return;
    }

    if (requestedMotionAssetIdRef.current) {
      void syncMotionAsset();
    }
  }, [motionScale, syncMotionAsset]);

  useEffect(() => {
    requestedMotionAssetIdRef.current = requestedMotionAssetId;
    void syncMotionAsset();
  }, [requestedMotionAssetId, syncMotionAsset]);

  useEffect(() => {
    if (sessionGeneration === 0) return;
    requestedMotionAssetIdRef.current = null;
    motionRequestGenerationRef.current += 1;
    motionAbortControllerRef.current?.abort();
    motionPlayerRef.current?.stop();
  }, [sessionGeneration]);

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
        const safeMotionScale = Math.max(
          0,
          Math.min(motionScaleRef.current, 1),
        );
        const gazeTarget = preReaction?.gaze?.target ?? attentionTargetRef.current;
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
          (avatarProfile?.headYawBias ?? preReaction?.motion?.headYawBias ?? 0) +
          gazeYawBias * (avatarProfile?.gazeDirectness ?? preReaction?.gaze?.directness ?? 0.72);
        const headYawBias = requestedHeadYawBias * safeMotionScale;
        const isBodyMotionPlaying =
          motionPlayerRef.current?.isPlaying() ?? false;
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
          );
        }
        motionPlayerRef.current?.update(delta);
        if (
          emotionController &&
          appliedEmotion !== emotionRef.current
        ) {
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
      motionAbortControllerRef.current?.abort();
      motionRequestGenerationRef.current += 1;
      motionPlayerRef.current?.dispose();
      motionPlayerRef.current = null;
      loadedVrmRef.current = null;
      if (loadedVrm) {
        scene.remove(loadedVrm.scene);
        VRMUtils.deepDispose(loadedVrm.scene);
      }
      renderer.dispose();
    };
  }, [isExhibitionMode, stageVariant, syncMotionAsset]);

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
}
