/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_APP_MODE?: string;
  readonly VITE_AUTONOMY_TIMING_MODE?: string;
  readonly VITE_AUDIO_PRESET?: string;
  readonly VITE_AUDIO_ENDPOINT_MS?: string;
  readonly VITE_VOICE_INPUT_TRANSPORT?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
