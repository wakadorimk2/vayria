import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { localApiPlugin } from './server/localApi';
import {
  resolveAivisCloudApiKey,
  resolveOpenAiApiKey,
} from './server/secretConfig';
import { resolveHttpsOptions } from './server/httpsConfig';
import { voiceStreamProxyPlugin } from './server/voiceStreamProxy';
import {
  createExhibitionNetworkRuntime,
  exhibitionNetworkPlugin,
} from './server/exhibitionNetwork';
import { createInternetConnectivityProbe } from './server/internetConnectivity';
import { resolveLlmRuntimeOptions } from './server/llmRuntime';

const DEFAULT_DEV_HOST = '127.0.0.1';
const DEFAULT_DEV_PORT = 5187;

function readEnvironmentValue(
  environment: Record<string, string>,
  canonicalName: string,
  legacyName: string,
): string | undefined {
  return environment[canonicalName]?.trim() || environment[legacyName]?.trim();
}

function readDevPort(value: string | undefined, variableName: string): number {
  const rawValue = value?.trim();
  if (!rawValue) return DEFAULT_DEV_PORT;

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${variableName} must be an integer from 1 to 65535.`);
  }

  return port;
}

function readBooleanEnvironment(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) return defaultValue;
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  throw new Error('VAYRIA_MDNS_ENABLED must be a boolean value.');
}

function readAppMode(value: string | undefined, viteMode: string):
  | 'local'
  | 'exhibition'
  | 'public' {
  const normalized = value?.trim();
  if (normalized === 'local' || normalized === 'exhibition' || normalized === 'public') {
    return normalized;
  }
  return viteMode === 'exhibition' ? 'exhibition' : 'local';
}

export default defineConfig(({ mode }) => {
  const serverEnvironment = loadEnv(mode, process.cwd(), '');
  const appMode = readAppMode(serverEnvironment.VITE_APP_MODE, mode);
  const processExhibitionBindHost =
    appMode === 'exhibition'
      ? process.env.VAYRIA_EXHIBITION_BIND_HOST?.trim()
      : undefined;
  const devHost =
    processExhibitionBindHost ||
    readEnvironmentValue(
        serverEnvironment,
        'VAYRIA_BIND_HOST',
        'WILDCARD_BIND_HOST',
      ) || DEFAULT_DEV_HOST;
  const portVariableName = serverEnvironment.VAYRIA_PORT?.trim()
    ? 'VAYRIA_PORT'
    : 'WILDCARD_PORT';
  const devPort = readDevPort(
    readEnvironmentValue(serverEnvironment, 'VAYRIA_PORT', 'WILDCARD_PORT'),
    portVariableName,
  );
  const httpsOptions = resolveHttpsOptions(serverEnvironment);
  const internetConnectivity = createInternetConnectivityProbe();
  const exhibitionNetwork =
    appMode === 'exhibition'
      ? createExhibitionNetworkRuntime({
          mdnsEnabled: readBooleanEnvironment(
            process.env.VAYRIA_MDNS_ENABLED?.trim() ||
              serverEnvironment.VAYRIA_MDNS_ENABLED,
            true,
          ),
          preferredIp:
            process.env.VAYRIA_EXHIBITION_HOTSPOT_IP?.trim() || undefined,
          preferredInterface:
            process.env.VAYRIA_EXHIBITION_INTERFACE_ALIAS?.trim() || undefined,
          httpsCertificate: httpsOptions?.cert,
        })
      : undefined;

  const plugins = [
    react(),
    localApiPlugin({
      openAiApiKey: resolveOpenAiApiKey(),
      aivisBaseUrl: serverEnvironment.AIVIS_BASE_URL,
      aivisSpeedScale: serverEnvironment.AIVIS_SPEED_SCALE,
      aivisPitchScale: serverEnvironment.AIVIS_PITCH_SCALE,
      aivisIntonationScale: serverEnvironment.AIVIS_INTONATION_SCALE,
      aivisTempoDynamicsScale:
        serverEnvironment.AIVIS_TEMPO_DYNAMICS_SCALE,
      ttsBackend: serverEnvironment.VAYRIA_TTS_BACKEND,
      aivisCloudApiKey: resolveAivisCloudApiKey(),
      aivisCloudBaseUrl: serverEnvironment.AIVIS_CLOUD_BASE_URL,
      aivisCloudModelUuid: serverEnvironment.AIVIS_CLOUD_MODEL_UUID,
      playcheckRoot: serverEnvironment.VAYRIA_PLAYCHECK_ROOT,
      exhibitionCaptureEnabled: appMode === 'exhibition',
      mode: appMode,
      port: devPort,
      httpsEnabled: Boolean(httpsOptions),
      exhibitionNetwork,
      internetConnectivity,
      llmRuntime: resolveLlmRuntimeOptions(
        {
          profile: serverEnvironment.VAYRIA_LLM_PROFILE,
          serviceTier: serverEnvironment.VAYRIA_LLM_SERVICE_TIER,
          fallbackEnabled: serverEnvironment.VAYRIA_LLM_FALLBACK_ENABLED,
          cacheWarmupEnabled:
            serverEnvironment.VAYRIA_LLM_CACHE_WARMUP_ENABLED,
        },
        appMode === 'exhibition',
      ),
    }),
    voiceStreamProxyPlugin(
      serverEnvironment.VAYRIA_STT_WS_URL?.trim() ||
        'ws://127.0.0.1:8787/stream',
    ),
  ];
  if (exhibitionNetwork) {
    plugins.push(
      exhibitionNetworkPlugin(exhibitionNetwork, {
        bindHost: devHost,
        port: devPort,
        httpsEnabled: Boolean(httpsOptions),
      }),
    );
  }

  return {
    plugins,
    server: {
      host: devHost,
      port: devPort,
      strictPort: true,
      https: httpsOptions,
    },
    build: {
      // AudioWorklet modules must be served as JavaScript assets, not data URLs.
      assetsInlineLimit: 0,
    },
  };
});
