export interface MediaSourceStreamTarget {
  addChunk(chunk: Uint8Array): void;
  end(): void;
  isUpdating(): boolean;
  waitForUpdate(): Promise<void>;
}

export function createMediaSourceStreamTarget(
  mediaSource: MediaSource,
  sourceBuffer: SourceBuffer,
): MediaSourceStreamTarget {
  const waitForUpdate = (): Promise<void> => {
    if (!sourceBuffer.updating) return Promise.resolve();
    return new Promise((resolve, reject) => {
      sourceBuffer.addEventListener('updateend', () => resolve(), { once: true });
      sourceBuffer.addEventListener(
        'error',
        () => reject(new Error('Streaming audio buffer failed.')),
        { once: true },
      );
    });
  };

  return {
    addChunk: (chunk) => sourceBuffer.appendBuffer(new Uint8Array(chunk).buffer),
    end: () => {
      if (mediaSource.readyState === 'open') mediaSource.endOfStream();
    },
    isUpdating: () => sourceBuffer.updating,
    waitForUpdate,
  };
}

export async function pumpMediaSourceAudio(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  target: MediaSourceStreamTarget,
  callbacks: {
    onComplete?: () => void;
    onFirstChunk?: () => void;
  } = {},
): Promise<void> {
  let receivedAudio = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (target.isUpdating()) await target.waitForUpdate();
    target.addChunk(value);
    await target.waitForUpdate();
    if (!receivedAudio) {
      receivedAudio = true;
      callbacks.onFirstChunk?.();
    }
  }
  if (!receivedAudio) throw new Error('Streaming audio response was empty.');
  if (target.isUpdating()) await target.waitForUpdate();
  target.end();
  callbacks.onComplete?.();
}
