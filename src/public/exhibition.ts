// Experience selection never changes the public transport or admission policy.
export type PublicExperience = 'normal' | 'exhibition';
export type ExhibitionAudioMode = 'release_capture' | 'duplex_auto' | 'duplex_record';
let experience: PublicExperience = 'normal';
let audioMode: ExhibitionAudioMode = 'release_capture';
const listeners = new Set<() => void>();
export const subscribeExhibition = (listener: () => void) => {
  listeners.add(listener); return () => { listeners.delete(listener); };
};
export const readPublicExperience = () => experience;
export const readExhibitionAudioMode = () => audioMode;
export const isSharedPublicConversation = () => experience === 'exhibition';
export const isDuplexCapture = () => isSharedPublicConversation() && audioMode !== 'release_capture';
export function configureExhibition(next: PublicExperience, audio: ExhibitionAudioMode = audioMode) {
  experience = next; audioMode = next === 'normal' ? 'release_capture' : audio;
  for (const listener of listeners) listener();
}

export interface AudioObservation {
  at: number;
  event: string;
  contextState?: string;
  requestedSession?: string;
  actualSession?: string;
  channelCount?: number;
  sampleRate?: number;
  echoCancellation?: boolean;
  noiseSuppression?: boolean;
  ducked?: boolean;
  queueDepth?: number;
}
let observations: readonly AudioObservation[] = [];
const observers = new Set<() => void>();
export const readAudioObservations = () => observations;
export const subscribeAudioObservations = (listener: () => void) => {
  observers.add(listener); return () => { observers.delete(listener); };
};
// Metadata only, bounded in memory. No transcripts, audio, or device identifiers.
export function observeExhibitionAudio(value: Omit<AudioObservation, 'at'>) {
  if (!isSharedPublicConversation()) return;
  observations = [...observations.slice(-39), { ...value, at: Date.now() }];
  for (const listener of observers) listener();
}

let comparingAudio = false;
export const isComparingAudio = () => comparingAudio;
export const setComparingAudio = (value: boolean) => { comparingAudio = value; };
