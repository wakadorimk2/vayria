import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { localApiPlugin } from './server/localApi';
import { resolveOpenAiApiKey } from './server/secretConfig';

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

export default defineConfig(({ mode }) => {
  const serverEnvironment = loadEnv(mode, process.cwd(), '');
  const devHost =
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

  return {
    plugins: [
      react(),
      localApiPlugin({
        openAiApiKey: resolveOpenAiApiKey(serverEnvironment),
        aivisBaseUrl: serverEnvironment.AIVIS_BASE_URL,
        aivisSpeedScale: serverEnvironment.AIVIS_SPEED_SCALE,
        aivisPitchScale: serverEnvironment.AIVIS_PITCH_SCALE,
        aivisIntonationScale: serverEnvironment.AIVIS_INTONATION_SCALE,
        aivisTempoDynamicsScale:
          serverEnvironment.AIVIS_TEMPO_DYNAMICS_SCALE,
      }),
    ],
    server: {
      host: devHost,
      port: devPort,
      strictPort: true,
    },
  };
});
