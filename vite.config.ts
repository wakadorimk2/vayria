import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { localApiPlugin } from './server/localApi';
import { resolveOpenAiApiKey } from './server/secretConfig';
import { voiceStreamProxyPlugin } from './server/voiceStreamProxy';

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

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(value?.trim().toLowerCase() ?? '');
}

function readHttpsOptions(environment: Record<string, string>) {
  if (!isEnabled(environment.VAYRIA_HTTPS)) return undefined;

  const certificateFile = environment.VAYRIA_HTTPS_CERT_FILE?.trim();
  const privateKeyFile = environment.VAYRIA_HTTPS_KEY_FILE?.trim();
  if (!certificateFile || !privateKeyFile) {
    throw new Error(
      'VAYRIA_HTTPS_CERT_FILE and VAYRIA_HTTPS_KEY_FILE are required when VAYRIA_HTTPS is enabled.',
    );
  }

  try {
    return {
      cert: readFileSync(certificateFile),
      key: readFileSync(privateKeyFile),
    };
  } catch (error) {
    throw new Error(
      `Vayria HTTPS certificate files could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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
      voiceStreamProxyPlugin(
        serverEnvironment.VAYRIA_STT_WS_URL?.trim() ||
          'ws://127.0.0.1:8787/stream',
      ),
    ],
    server: {
      host: devHost,
      port: devPort,
      strictPort: true,
      https: readHttpsOptions(serverEnvironment),
    },
    build: {
      // AudioWorklet modules must be served as JavaScript assets, not data URLs.
      assetsInlineLimit: 0,
    },
  };
});
