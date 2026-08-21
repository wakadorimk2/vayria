import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { localApiPlugin } from './server/localApi';

export default defineConfig(({ mode }) => {
  const serverEnvironment = loadEnv(mode, process.cwd(), '');

  return {
    plugins: [
      react(),
      localApiPlugin({
        openAiApiKey: serverEnvironment.OPENAI_API_KEY,
        aivisBaseUrl: serverEnvironment.AIVIS_BASE_URL,
      }),
    ],
    server: {
      host: '127.0.0.1',
      port: 5187,
    },
  };
});
