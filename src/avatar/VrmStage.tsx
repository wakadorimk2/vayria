import { useEffect, useRef, useState } from 'react';
import {
  AmbientLight,
  Box3,
  Clock,
  DirectionalLight,
  PerspectiveCamera,
  Scene,
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

const MODEL_URL = `${import.meta.env.BASE_URL}avatar/model.vrm`;

interface VrmStageProps {
  mouthOpen: number;
}

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

function frameAvatar(
  vrm: VRM,
  camera: PerspectiveCamera,
  width: number,
  height: number,
): void {
  const bounds = new Box3().setFromObject(vrm.scene);
  const size = bounds.getSize(new Vector3());
  const modelHeight = Math.max(size.y, 1);
  const modelWidth = Math.max(size.x, 0.5);
  const verticalFov = (camera.fov * Math.PI) / 180;
  const aspect = Math.max(width / Math.max(height, 1), 0.1);
  const horizontalFov = 2 * Math.atan(Math.tan(verticalFov / 2) * aspect);
  const visibleHeight = modelHeight * 0.72;
  const visibleWidth = modelWidth * 0.82;
  const distance = Math.max(
    visibleHeight / (2 * Math.tan(verticalFov / 2)),
    visibleWidth / (2 * Math.tan(horizontalFov / 2)),
  );
  const lookAtY = modelHeight * 0.68;

  camera.aspect = aspect;
  camera.position.set(0, lookAtY, distance);
  camera.near = 0.01;
  camera.far = Math.max(50, distance * 20);
  camera.lookAt(0, lookAtY, 0);
  camera.updateProjectionMatrix();
}

export function VrmStage({ mouthOpen }: VrmStageProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouthOpenRef = useRef(mouthOpen);
  const [loadState, setLoadState] = useState<LoadState>('loading');
  const [expressionWarning, setExpressionWarning] = useState('');

  useEffect(() => {
    mouthOpenRef.current = mouthOpen;
  }, [mouthOpen]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const scene = new Scene();
    const camera = new PerspectiveCamera(30, 1, 0.01, 50);
    scene.add(new AmbientLight(0xffffff, 1.2));
    const keyLight = new DirectionalLight(0xffffff, 1.4);
    keyLight.position.set(1.5, 2.5, 2);
    scene.add(keyLight);

    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true });
    } catch {
      queueMicrotask(() => setLoadState('error'));
      return;
    }
    renderer.setClearAlpha(0);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    (
      renderer as WebGLRenderer & {
        outputColorSpace?: string;
      }
    ).outputColorSpace = 'srgb';

    let disposed = false;
    let loadedVrm: VRM | null = null;
    let animationFrame = 0;
    let mouthExpression: string | null = null;

    const resize = () => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      renderer.setSize(width, height, false);
      if (loadedVrm) frameAvatar(loadedVrm, camera, width, height);
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

          const expression = vrm.expressionManager?.getExpression(
            VRMExpressionPresetName.Aa,
          );
          if (expression) {
            mouthExpression = VRMExpressionPresetName.Aa;
          } else {
            setExpressionWarning(
              'この VRM には標準の aa 口形状がありません。モデルは表示できますが、口パクは利用できません。',
            );
          }

          frameAvatar(
            vrm,
            camera,
            container.clientWidth,
            container.clientHeight,
          );
          setLoadState('ready');
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
        if (mouthExpression) {
          loadedVrm.expressionManager?.setValue(
            mouthExpression,
            mouthOpenRef.current,
          );
          loadedVrm.expressionManager?.update();
        }
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
      if (loadedVrm) {
        scene.remove(loadedVrm.scene);
        VRMUtils.deepDispose(loadedVrm.scene);
      }
      renderer.dispose();
    };
  }, []);

  return (
    <div className="vrm-stage" ref={containerRef}>
      <canvas
        aria-label="Wildcard VRM character"
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
