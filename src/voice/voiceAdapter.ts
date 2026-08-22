import type { VoiceInputEvent } from './voiceInput.js';

export interface VoiceInputAdapter {
  readonly isSupported: boolean;
  readonly supportErrorCode: string | null;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  dispose(): void;
}

export interface VoiceInputAdapterOptions {
  language?: string;
  onEvent: (event: VoiceInputEvent) => void;
}
