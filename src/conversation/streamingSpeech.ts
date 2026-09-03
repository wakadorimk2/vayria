export interface StreamingSpeechUnitEvent<TResponse = unknown> {
  type: 'speech_unit';
  index: number;
  text: string;
  response: TResponse;
}

export interface StreamingStateEvent {
  type: 'state';
  internalDelta: unknown;
  rejected: boolean;
}

export interface StreamingProviderTimingEvent {
  type: 'provider_timing';
  milestone: 'start' | 'first_chunk' | 'done';
  purpose: 'conversation-policy' | 'response-generation' | 'card-preview';
  callIndex: number;
  retry: number;
}

export interface StreamingDoneEvent<TResponse = unknown> {
  type: 'done';
  response: TResponse;
}

export interface StreamingErrorEvent {
  type: 'error';
  error: string;
}

export type StreamingChatEvent<TResponse = unknown> =
  | StreamingSpeechUnitEvent<TResponse>
  | StreamingProviderTimingEvent
  | StreamingStateEvent
  | StreamingDoneEvent<TResponse>
  | StreamingErrorEvent;

function parseStreamingChatEvent<TResponse>(line: string): StreamingChatEvent<TResponse> {
  const value = JSON.parse(line) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Streaming chat event must be an object.');
  }
  const record = value as Record<string, unknown>;
  if (
    record.type === 'provider_timing' &&
    (record.milestone === 'start' ||
      record.milestone === 'first_chunk' ||
      record.milestone === 'done') &&
    (record.purpose === 'conversation-policy' ||
      record.purpose === 'response-generation' ||
      record.purpose === 'card-preview') &&
    Number.isSafeInteger(record.callIndex) &&
    (record.callIndex as number) > 0 &&
    Number.isSafeInteger(record.retry) &&
    (record.retry as number) >= 0
  ) {
    return value as StreamingProviderTimingEvent;
  }
  if (
    record.type === 'speech_unit' &&
    Number.isSafeInteger(record.index) &&
    (record.index as number) >= 0 &&
    typeof record.text === 'string' &&
    record.response &&
    typeof record.response === 'object'
  ) {
    return value as StreamingSpeechUnitEvent<TResponse>;
  }
  if (record.type === 'state' && typeof record.rejected === 'boolean') {
    return value as StreamingStateEvent;
  }
  if (
    record.type === 'done' &&
    record.response &&
    typeof record.response === 'object'
  ) {
    return value as StreamingDoneEvent<TResponse>;
  }
  if (record.type === 'error' && typeof record.error === 'string') {
    return value as StreamingErrorEvent;
  }
  throw new Error('Streaming chat event has an invalid shape.');
}

export async function readStreamingChatEvents<TResponse>(
  response: Response,
  onEvent: (event: StreamingChatEvent<TResponse>) => void | Promise<void>,
): Promise<void> {
  if (!response.body) throw new Error('Streaming chat response has no body.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) await onEvent(parseStreamingChatEvent<TResponse>(line));
      }
    }
    buffer += decoder.decode();
    const tail = buffer.trim();
    if (tail) await onEvent(parseStreamingChatEvent<TResponse>(tail));
  } finally {
    reader.releaseLock();
  }
}
