export type AudioPlaybackSource =
  | {
      kind: 'buffer';
      data: ArrayBuffer;
      mimeType: string;
    }
  | {
      kind: 'stream';
      mimeType: string;
      stream: ReadableStream<Uint8Array>;
    };

export async function readAudioPlaybackSource(
  response: Response,
): Promise<AudioPlaybackSource> {
  const mimeType =
    response.headers.get('Content-Type')?.split(';', 1)[0]?.trim().toLowerCase() ||
    'application/octet-stream';
  if (mimeType === 'audio/mpeg' && response.body) {
    return { kind: 'stream', mimeType, stream: response.body };
  }
  return {
    kind: 'buffer',
    data: await response.arrayBuffer(),
    mimeType,
  };
}
