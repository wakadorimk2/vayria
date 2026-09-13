import type { VoiceInputEvent } from './voiceInput.js';
import type { VoiceInputDiagnostic } from './audioLab.js';

export interface VoiceInputAdapter {
  readonly isSupported: boolean;
  readonly supportErrorCode: string | null;
  start(): Promise<boolean>;
  stop(): Promise<void>;
  setVadThreshold?(value: number): void;
  setTtsPlaying?(isPlaying: boolean): void;
  dispose(): void;
}

export interface VoiceInputAdapterOptions {
  sharedVoice?: { active:()=>boolean; send:(audio:ArrayBuffer,signal:AbortSignal)=>Promise<Response>; reserve?:()=>{send:(audio:ArrayBuffer,signal:AbortSignal)=>Promise<Response>;cancel:()=>void} };
  language?: string;
  onEvent: (event: VoiceInputEvent) => void;
  onDiagnostic?: (diagnostic: VoiceInputDiagnostic) => void;
}
