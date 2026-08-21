import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { localApiPlugin } from './server/localApi';

const DEFAULT_DEV_HOST = '127.0.0.1';
const DEFAULT_DEV_PORT = 5187;

function readDevPort(value: string | undefined): number {
  const rawValue = value?.trim();
  if (!rawValue) return DEFAULT_DEV_PORT;

  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WILDCARD_PORT must be an integer from 1 to 65535.');
  }

  return port;
}

export default defineConfig(({ mode }) => {
  const serverEnvironment = loadEnv(mode, process.cwd(), '');
  const devHost =
    serverEnvironment.WILDCARD_BIND_HOST?.trim() || DEFAULT_DEV_HOST;
  const devPort = readDevPort(serverEnvironment.WILDCARD_PORT);

  return {
    plugins: [
      react(),
      localApiPlugin({
        openAiApiKey: serverEnvironment.OPENAI_API_KEY,
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
