import { LIVE_CLOSE_TIMEOUT_MS, LIVE_HEARTBEAT_MS, type LiveCardContext, type LivePhase } from './liveProtocol';
import { LiveConnectionError, liveStartFailure, type LiveStartStage } from './liveErrors';

export interface LiveCaption { id: string; speaker: 'user' | 'assistant'; delta: string; start_ms: number; end_ms: number }
export interface LiveSnapshot {
  phase: LivePhase; error: string | null; captions: LiveCaption[]; mouthOpen: number; microphoneLevel: number;
  speaking: boolean; needsPlaybackGesture: boolean; seconds: number; confirmedRevision: number | null;
}
const initial = (): LiveSnapshot => ({ phase: 'idle', error: null, captions: [], mouthOpen: 0, microphoneLevel: 0,
  speaking: false, needsPlaybackGesture: false, seconds: 0, confirmedRevision: null });
export interface LiveBrowserDependencies {
  holdRecording?: () => () => void;
  getMicrophone: () => Promise<MediaStream>;
  peer: () => RTCPeerConnection;
  audio: () => AudioContext;
  request: (operation: 'start' | 'context' | 'stop', input: object, sessionId: string) => Promise<Record<string, unknown>>;
  frame: (callback: FrameRequestCallback) => number;
  cancelFrame: (id: number) => void;
}

/** Owns one browser connection. A new generation invalidates every pending start. */
export class LiveConversation {
  private snapshot = initial();
  private listeners = new Set<() => void>();
  private generation = 0;
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private microphone: MediaStream | null = null;
  private releaseRecording: (() => void) | null = null;
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private inputAnalyser: AnalyserNode | null = null;
  private outputAnalyser: AnalyserNode | null = null;
  private frame = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private startup: ReturnType<typeof setTimeout> | null = null;
  private stopping: Promise<void> | null = null;
  private finishClose: (() => void) | null = null;
  private cancelMicrophoneWait: (() => void) | null = null;
  private cards: LiveCardContext = { swapRevision: 0, brainCardIds: [], forcedCardId: null };
  private sentRevision = -1;
  private updatePending: number | null = null;
  private requestId = '';
  private sessionId = '';
  private volume = 1;
  constructor(private dependencies: LiveBrowserDependencies) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private set(value: Partial<LiveSnapshot>) { this.snapshot = { ...this.snapshot, ...value }; for (const listener of this.listeners) listener(); }
  setVolume(volume: number) { this.volume = Math.max(0, Math.min(1, volume)); if (this.gain) this.gain.gain.value = this.volume; }
  prepare = () => {
    const context = this.context ??= this.dependencies.audio();
    void context.resume().then(() => {
      if (this.context === context) this.set({ needsPlaybackGesture: context.state !== 'running' });
    }).catch(() => {
      if (this.context === context) this.set({ needsPlaybackGesture: true });
    });
  };
  async start(sessionId: string, cards: LiveCardContext): Promise<boolean> {
    if (this.stopping || this.snapshot.phase === 'starting' || this.snapshot.phase === 'connected') return false;
    const generation = ++this.generation;
    const current = () => generation === this.generation;
    this.sessionId = sessionId; this.requestId = crypto.randomUUID(); this.cards = cards; this.sentRevision = -1;
    this.snapshot = initial(); this.set({ phase: 'starting' });
    this.startup = setTimeout(() => { if (current()) void this.fail('音声接続が時間内に完了しませんでした。'); }, 40_000);
    let stage: LiveStartStage = 'microphone';
    try {
      this.releaseRecording = this.dependencies.holdRecording?.() ?? null;
      this.prepare();
      const acquisition = this.dependencies.getMicrophone();
      void acquisition.then(stream => { if (!current()) stream.getTracks().forEach(track => track.stop()); }, () => {});
      const microphone = await Promise.race([acquisition, new Promise<null>(resolve => { this.cancelMicrophoneWait = () => resolve(null); })]);
      if (!microphone) return false;
      this.cancelMicrophoneWait = null;
      if (!current()) { microphone.getTracks().forEach(track => track.stop()); return false; }
      this.microphone = microphone;
      stage = 'offer';
      const context = this.context!;
      this.inputAnalyser = context.createAnalyser(); this.inputAnalyser.fftSize = 1024;
      context.createMediaStreamSource(microphone).connect(this.inputAnalyser);
      const peer = this.dependencies.peer(); this.peer = peer;
      const channel = peer.createDataChannel('oai-events'); this.channel = channel;
      channel.addEventListener('message', event => {
        if (!current()) { if (this.snapshot.phase === 'stopping') this.receiveClose(event.data); return; }
        this.receive(event.data);
      });
      channel.addEventListener('close', () => { if (current() && this.snapshot.phase !== 'idle') void this.fail('音声接続が切れました。マイク操作で再接続できます。'); });
      peer.addEventListener('connectionstatechange', () => {
        if (current() && ['failed', 'disconnected'].includes(peer.connectionState)) void this.fail('音声接続が切れました。');
      });
      peer.addEventListener('track', event => {
        if (!current()) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        this.outputAnalyser = context.createAnalyser(); this.outputAnalyser.fftSize = 1024;
        this.gain = context.createGain(); this.gain.gain.value = this.volume;
        context.createMediaStreamSource(stream).connect(this.outputAnalyser);
        this.outputAnalyser.connect(this.gain); this.gain.connect(context.destination);
        this.set({ needsPlaybackGesture: context.state !== 'running' });
      });
      microphone.getTracks().forEach(track => peer.addTrack(track, microphone));
      await peer.setLocalDescription(await peer.createOffer());
      stage = 'ice';
      await this.waitForIce(peer);
      if (!current()) return false;
      const requestId = this.requestId;
      stage = 'server';
      const result = await this.dependencies.request('start', { sdp: peer.localDescription?.sdp, cards: this.cards, requestId }, sessionId);
      if (!current()) {
        // Creation can complete after stop/visibility cancellation. Close that exact admission.
        await this.dependencies.request('stop', { requestId }, sessionId).catch(() => {});
        return false;
      }
      const sdp = (result.transport as { sdp?: unknown } | undefined)?.sdp;
      if (typeof sdp !== 'string') throw new Error('invalid answer');
      stage = 'answer';
      await peer.setRemoteDescription({ type: 'answer', sdp });
      this.measure(generation);
      return true;
    } catch (error) {
      if (current()) await this.fail(liveStartFailure(error, stage));
      return false;
    }
  }
  private waitForIce(peer: RTCPeerConnection) {
    if (peer.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', ready); reject(new LiveConnectionError('live_ice_timeout')); }, 10_000);
      const ready = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timeout); peer.removeEventListener('icegatheringstatechange', ready); resolve(); } };
      peer.addEventListener('icegatheringstatechange', ready); ready();
    });
  }
  private receive(data: unknown) {
    let event: Record<string, unknown>;
    try { event = JSON.parse(String(data)); } catch { return; }
    if (event.type === 'session.started') {
      if (this.snapshot.phase !== 'starting') return;
      if (this.startup) clearTimeout(this.startup); this.startup = null;
      this.set({ phase: 'connected' });
      void this.flush();
      this.heartbeat = setInterval(() => { void this.flush(); }, LIVE_HEARTBEAT_MS);
    } else if (event.type === 'session.closed') {
      this.finishClose?.();
      if (this.snapshot.phase !== 'stopping') { ++this.generation; this.release(); this.set({ phase: 'idle', speaking: false, mouthOpen: 0 }); }
    } else if (event.type === 'session.input_transcript.delta' || event.type === 'session.output_transcript.delta') {
      if (typeof event.delta !== 'string' || typeof event.start_ms !== 'number' || typeof event.end_ms !== 'number') return;
      const id = typeof event.event_id === 'string' ? event.event_id : crypto.randomUUID();
      if (this.snapshot.captions.some(c => c.id === id)) return;
      const caption: LiveCaption = { id, speaker: event.type === 'session.input_transcript.delta' ? 'user' : 'assistant',
        delta: event.delta, start_ms: event.start_ms, end_ms: event.end_ms };
      this.set({ captions: [...this.snapshot.captions, caption].sort((a, b) => a.start_ms - b.start_ms).slice(-500) });
    } else if (event.type === 'error') void this.fail('GPT-Liveが音声処理を続けられませんでした。');
  }
  private receiveClose(data: unknown) {
    try { if (JSON.parse(String(data)).type === 'session.closed') this.finishClose?.(); } catch { /* Ignore malformed events. */ }
  }
  updateCards = (cards: LiveCardContext) => {
    if (cards.swapRevision < this.cards.swapRevision) return;
    this.cards = cards;
    if (this.snapshot.phase === 'connected') void this.flush();
  };
  private async flush() {
    if (this.updatePending === this.generation || this.snapshot.phase !== 'connected') return;
    this.updatePending = this.generation;
    const generation = this.generation;
    const cards = this.cards;
    try {
      const result = await this.dependencies.request('context', { requestId: this.requestId,
        ...(cards.swapRevision > this.sentRevision ? { cards } : {}) }, this.sessionId);
      if (generation !== this.generation) return;
      this.sentRevision = Math.max(this.sentRevision, cards.swapRevision);
      this.set({ seconds: typeof result.seconds === 'number' ? result.seconds : this.snapshot.seconds,
        confirmedRevision: typeof result.confirmedRevision === 'number' ? result.confirmedRevision : null });
    } catch { if (generation === this.generation) await this.fail('接続状態を確認できませんでした。録音を停止しました。'); }
    finally {
      if (this.updatePending === generation) this.updatePending = null;
      if (generation === this.generation && this.cards.swapRevision > cards.swapRevision) void this.flush();
    }
  }
  private measure(generation: number) {
    const samples = new Float32Array(1024);
    const rms = (analyser: AnalyserNode | null) => {
      if (!analyser) return 0; analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, sample) => sum + sample * sample, 0) / samples.length);
    };
    const tick = () => {
      if (generation !== this.generation) return;
      const output = rms(this.outputAnalyser);
      this.set({ mouthOpen: this.volume > 0 ? Math.min(output * 12, 1) : 0,
        speaking: output > 0.008, microphoneLevel: Math.min(rms(this.inputAnalyser) * 12, 1) });
      this.frame = this.dependencies.frame(tick);
    }; tick();
  }
  private async fail(message: string) {
    const stopped = this.stop(); const generation = this.generation;
    await stopped;
    if (generation === this.generation) this.set({ phase: 'error', error: message });
  }
  stop = (): Promise<void> => {
    if (this.stopping) return this.stopping;
    if (this.snapshot.phase === 'idle' && !this.peer && !this.microphone) { this.release(); return Promise.resolve(); }
    ++this.generation;
    this.cancelMicrophoneWait?.(); this.cancelMicrophoneWait = null;
    const requestId = this.requestId; const sessionId = this.sessionId;
    this.set({ phase: 'stopping', speaking: false, mouthOpen: 0, microphoneLevel: 0 });
    this.microphone?.getTracks().forEach(track => track.stop());
    if (this.gain) this.gain.gain.value = 0;
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (this.startup) clearTimeout(this.startup); this.startup = null;
    const channel = this.channel;
    this.stopping = (async () => {
      const finalized = new Promise<void>(resolve => {
        const timeout = setTimeout(resolve, LIVE_CLOSE_TIMEOUT_MS);
        this.finishClose = () => { clearTimeout(timeout); resolve(); };
        if (channel?.readyState === 'open') { try { channel.send(JSON.stringify({ type: 'session.close' })); } catch { this.finishClose(); } }
        else this.finishClose();
      });
      await Promise.all([finalized, requestId && sessionId ? this.dependencies.request('stop', { requestId }, sessionId).catch(() => {}) : Promise.resolve()]);
      this.finishClose = null; this.release(); this.set({ phase: 'idle', needsPlaybackGesture: false });
    })().finally(() => { this.stopping = null; });
    return this.stopping;
  };
  private release() {
    this.dependencies.cancelFrame(this.frame);
    if (this.heartbeat) clearInterval(this.heartbeat); this.heartbeat = null;
    if (this.startup) clearTimeout(this.startup); this.startup = null;
    this.microphone?.getTracks().forEach(track => track.stop()); this.microphone = null;
    this.channel?.close(); this.channel = null; this.peer?.close(); this.peer = null;
    this.inputAnalyser = null; this.outputAnalyser = null; this.gain = null;
    void this.context?.close().catch(() => {}); this.context = null;
    this.releaseRecording?.(); this.releaseRecording = null;
  }
}
