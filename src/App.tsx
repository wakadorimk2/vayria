import {
  useCallback,
  useEffect,
  useState,
  type FormEvent,
} from 'react';
import { VrmStage } from './avatar/VrmStage';
import { useAudioLipSync } from './audio/useAudioLipSync';
import { CardGamePrototype } from './cards/CardGamePrototype';
import { useCardGamePrototype } from './cards/useCardGamePrototype';
import { useAutonomousTalk } from './conversation/useAutonomousTalk';
import {
  useConversation,
  type AutonomousContext,
  type AutonomousDecision,
  type ChatCardContext,
} from './conversation/useConversation';
import type { CardSwapResult } from './cards/useCardGamePrototype';
import { runtimeConfig } from './runtimeConfig';

const STATUS_LABELS = {
  idle: '話しかけてください。',
  thinking: '考えています…',
  synthesizing: '返答音声を作っています…',
  speaking: '話しています。',
  error: '処理を完了できませんでした。',
} as const;

const AUDIO_SETTINGS_STORAGE_KEY = 'wildcard.audio-settings.v1';

interface AudioControlState {
  isMuted: boolean;
  lastAudibleVolume: number;
  volume: number;
}

function createDefaultAudioControlState(): AudioControlState {
  return { isMuted: false, lastAudibleVolume: 1, volume: 1 };
}

function readStoredVolume(value: unknown, allowZero: boolean): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < (allowZero ? 0 : Number.EPSILON) || value > 1) return null;
  return value;
}

function readAudioControlState(): AudioControlState {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(AUDIO_SETTINGS_STORAGE_KEY) ?? 'null',
    ) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return createDefaultAudioControlState();
    }

    const record = parsed as Record<string, unknown>;
    const volume = readStoredVolume(record.volume, true);
    const lastAudibleVolume = readStoredVolume(
      record.lastAudibleVolume,
      false,
    );
    if (volume === null || lastAudibleVolume === null) {
      return createDefaultAudioControlState();
    }
    return {
      isMuted: volume === 0,
      lastAudibleVolume,
      volume,
    };
  } catch {
    return createDefaultAudioControlState();
  }
}

function advanceAutonomousContext(
  current: AutonomousContext,
  decision: AutonomousDecision,
): AutonomousContext {
  if (decision.action === 'silence') return current;

  return {
    topic: decision.topic,
    topicTurns:
      decision.action === 'new_topic' || current.topic === null
        ? 1
        : current.topicTurns + 1,
  };
}

export default function App() {
  const [input, setInput] = useState('');
  const [isAvatarReady, setIsAvatarReady] = useState(false);
  const [audioControl, setAudioControl] = useState(readAudioControlState);
  const [autonomousContext, setAutonomousContext] =
    useState<AutonomousContext>({ topic: null, topicTurns: 0 });
  const { isMuted, lastAudibleVolume, volume } = audioControl;
  const isExhibitionMode = runtimeConfig.mode === 'exhibition';
  const cardGame = useCardGamePrototype();
  const { acceptReply, beginReply, zones } = cardGame;
  const {
    isAudioUnlocked,
    mouthOpen,
    play,
    prepare,
    stop,
  } = useAudioLipSync(volume);
  const {
    cancelAutonomous,
    emotion,
    error,
    isBusy,
    isManualBusy,
    reply,
    sendAutonomous,
    sendManual,
    status,
  } = useConversation(play, stop, { historyLimit: 6, isMuted });
  const trimmedInput = input.trim();
  const volumePercent = Math.round(volume * 100);

  useEffect(() => {
    try {
      localStorage.setItem(
        AUDIO_SETTINGS_STORAGE_KEY,
        JSON.stringify({ volume, lastAudibleVolume }),
      );
    } catch {
      // Playback remains usable when storage is unavailable.
    }
  }, [lastAudibleVolume, volume]);

  const readCardContext = useCallback(
    () => ({
      brainCardIds: zones.brain.map((card) => card.id),
      forcedCardId: zones.forcedCardId,
    }),
    [zones.brain, zones.forcedCardId],
  );

  const startAutonomous = useCallback(
    async (cardContextOverride?: ChatCardContext) => {
      if (isExhibitionMode) {
        const audioReady = await prepare();
        if (!audioReady) return false;
      } else {
        void prepare();
      }
      beginReply();
      const decision = await sendAutonomous(
        cardContextOverride ?? readCardContext(),
        autonomousContext,
        acceptReply,
      );
      if (!decision) return false;
      setAutonomousContext((current) =>
        advanceAutonomousContext(current, decision),
      );
      return true;
    },
    [
      acceptReply,
      autonomousContext,
      beginReply,
      isExhibitionMode,
      prepare,
      readCardContext,
      sendAutonomous,
    ],
  );

  const handleCardInserted = useCallback(
    (result: CardSwapResult) => {
      if (isMuted) return;
      void startAutonomous({
        brainCardIds: result.brainCardIds,
        forcedCardId: result.forcedCardId,
      });
    },
    [isMuted, startAutonomous],
  );

  useAutonomousTalk({
    cancelAutonomous,
    isBusy,
    isMuted,
    isReady:
      isAvatarReady && (!isExhibitionMode || isAudioUnlocked),
    startAutonomous,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isManualBusy) return;
    beginReply();
    if (!isMuted) void prepare();
    setInput('');
    void sendManual(trimmedInput, readCardContext(), acceptReply);
  };

  const handleMuteToggle = () => {
    if (isMuted) {
      const restoredVolume = volume > 0 ? volume : lastAudibleVolume;
      void prepare();
      setAudioControl({
        isMuted: false,
        lastAudibleVolume: restoredVolume,
        volume: restoredVolume,
      });
    } else {
      stop();
      setAudioControl((current) => ({ ...current, isMuted: true }));
    }
  };

  const handleVolumeInput = (event: FormEvent<HTMLInputElement>) => {
    const inputVolume = Number(event.currentTarget.value) / 100;
    if (!Number.isFinite(inputVolume)) return;
    const nextVolume = Math.max(0, Math.min(inputVolume, 1));
    if (nextVolume === 0) {
      stop();
      setAudioControl((current) => ({
        ...current,
        isMuted: true,
        volume: 0,
      }));
      return;
    }

    if (isMuted) void prepare();
    setAudioControl({
      isMuted: false,
      lastAudibleVolume: nextVolume,
      volume: nextVolume,
    });
  };

  const handleAvatarReady = useCallback(() => {
    void prepare();
    setIsAvatarReady(true);
  }, [prepare]);

  return (
    <main className="app-shell">
      <header className="app-title">
        <span>Wildcard</span>
        <div
          className="audio-controls"
          aria-label="音声コントロール"
          role="group"
        >
          {isExhibitionMode && !isAudioUnlocked && !isMuted && (
            <button
              aria-label="音声を有効化する"
              className="audio-unlock-button"
              onClick={() => {
                void prepare();
              }}
              title="最初の音声再生を有効にします"
              type="button"
            >
              音声を有効化
            </button>
          )}
          <button
            aria-label={isMuted ? '音声をオンにする' : '音声をミュートする'}
            aria-pressed={isMuted}
            className="mute-button"
            onClick={handleMuteToggle}
            title={isMuted ? 'Muted' : 'Autonomous talk active'}
            type="button"
          >
            <span aria-hidden="true">{isMuted ? '🔇' : '🔊'}</span>
          </button>
          <label className="visually-hidden" htmlFor="playback-volume">
            再生音量
          </label>
          <input
            aria-valuetext={
              isMuted
                ? `ミュート中、設定音量 ${volumePercent}%`
                : `音量 ${volumePercent}%`
            }
            className="volume-slider"
            id="playback-volume"
            max="100"
            min="0"
            onInput={handleVolumeInput}
            step="5"
            type="range"
            value={volumePercent}
          />
          <span className="volume-value" aria-hidden="true">
            {volumePercent}%
          </span>
        </div>
      </header>

      <section className="avatar-area" aria-label="VRM character">
        <VrmStage
          emotion={emotion}
          mouthOpen={mouthOpen}
          onReady={handleAvatarReady}
        />
        <CardGamePrototype
          game={cardGame}
          isInteractionLocked={isBusy}
          onCardInserted={handleCardInserted}
        />
      </section>

      <section className="conversation" aria-label="Character conversation">
        <div className="conversation-copy" aria-live="polite">
          {reply && <p className="reply">{reply}</p>}
          <p className="status">
            {isMuted && status === 'idle'
              ? 'ミュート中です。テキスト会話は利用できます。'
              : STATUS_LABELS[status]}
          </p>
          {error && (
            <p className="conversation-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <form className="message-form" onSubmit={handleSubmit}>
          <label className="visually-hidden" htmlFor="message-input">
            キャラクターへ送るメッセージ
          </label>
          <input
            autoComplete="off"
            disabled={isManualBusy}
            id="message-input"
            maxLength={1000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="メッセージを入力"
            type="text"
            value={input}
          />
          <button disabled={!trimmedInput || isManualBusy} type="submit">
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
