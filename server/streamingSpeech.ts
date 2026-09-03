export interface StreamingSpeechChunk {
  deliveryHeader?: unknown;
  speechLead?: string;
  speechUnits: string[];
}

interface JsonValueRange {
  end: number;
  value: unknown;
}

function skipWhitespace(text: string, offset: number): number {
  let cursor = offset;
  while (cursor < text.length && /\s/u.test(text[cursor])) cursor += 1;
  return cursor;
}

function findStringEnd(text: string, start: number): number | null {
  if (text[start] !== '"') return null;
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === '\\') {
      escaped = true;
      continue;
    }
    if (character === '"') return cursor + 1;
  }
  return null;
}

function findStructuredValueEnd(text: string, start: number): number | null {
  const opening = text[start];
  if (opening !== '{' && opening !== '[') return null;
  const stack = [opening];
  let inString = false;
  let escaped = false;
  for (let cursor = start + 1; cursor < text.length; cursor += 1) {
    const character = text[cursor];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === '\\') escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
      continue;
    }
    if (character === '{' || character === '[') stack.push(character);
    else if (character === '}' || character === ']') {
      const expected = character === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) return null;
      stack.pop();
      if (stack.length === 0) return cursor + 1;
    }
  }
  return null;
}

function readPropertyValue(
  text: string,
  property: string,
  from = 0,
): JsonValueRange | null {
  const key = JSON.stringify(property);
  const keyOffset = text.indexOf(key, from);
  if (keyOffset < 0) return null;
  let cursor = skipWhitespace(text, keyOffset + key.length);
  if (text[cursor] !== ':') return null;
  cursor = skipWhitespace(text, cursor + 1);
  const end =
    text[cursor] === '"'
      ? findStringEnd(text, cursor)
      : findStructuredValueEnd(text, cursor);
  if (end === null) return null;
  try {
    return { end, value: JSON.parse(text.slice(cursor, end)) };
  } catch {
    return null;
  }
}

export class IncrementalSpeechEnvelopeParser {
  private buffer = '';
  private deliveryHeaderRead = false;
  private deliveryHeaderEnd = 0;
  private speechLeadRead = false;
  private speechLeadEnd = 0;
  private speechArrayOffset: number | null = null;
  private speechCursor: number | null = null;

  push(chunk: string): StreamingSpeechChunk {
    this.buffer += chunk;
    const result: StreamingSpeechChunk = { speechUnits: [] };
    if (!this.deliveryHeaderRead) {
      const header = readPropertyValue(this.buffer, 'deliveryHeader');
      if (header) {
        this.deliveryHeaderRead = true;
        this.deliveryHeaderEnd = header.end;
        result.deliveryHeader = header.value;
      }
    }

    if (!this.speechLeadRead && this.deliveryHeaderRead) {
      const lead = readPropertyValue(
        this.buffer,
        'speechLead',
        this.deliveryHeaderEnd,
      );
      if (lead && typeof lead.value === 'string') {
        this.speechLeadRead = true;
        this.speechLeadEnd = lead.end;
        result.speechLead = lead.value;
      }
    }

    if (this.speechArrayOffset === null && this.speechLeadRead) {
      const key = JSON.stringify('speechUnits');
      const keyOffset = this.buffer.indexOf(key, this.speechLeadEnd);
      if (keyOffset >= 0) {
        let cursor = skipWhitespace(this.buffer, keyOffset + key.length);
        if (this.buffer[cursor] === ':') cursor = skipWhitespace(this.buffer, cursor + 1);
        if (this.buffer[cursor] === '[') {
          this.speechArrayOffset = cursor;
          this.speechCursor = cursor + 1;
        }
      }
    }

    if (this.speechCursor === null) return result;
    for (;;) {
      let cursor = skipWhitespace(this.buffer, this.speechCursor);
      if (this.buffer[cursor] === ',') cursor = skipWhitespace(this.buffer, cursor + 1);
      if (cursor >= this.buffer.length || this.buffer[cursor] === ']') {
        this.speechCursor = cursor;
        break;
      }
      if (this.buffer[cursor] !== '"') break;
      const end = findStringEnd(this.buffer, cursor);
      if (end === null) break;
      try {
        const unit = JSON.parse(this.buffer.slice(cursor, end));
        if (typeof unit === 'string') result.speechUnits.push(unit);
      } catch {
        break;
      }
      this.speechCursor = end;
    }
    return result;
  }
}

export interface StreamingSpeechEnvelope {
  deliveryHeader: Record<string, unknown>;
  speechLead: string;
  speechUnits: string[];
  activatedCards: string[];
  internalDelta: unknown;
}

export function isValidSpeechLead(value: string): boolean {
  const length = Array.from(value.trim()).length;
  return length >= 4 && length <= 12;
}

export function isAcceptedSpeechLead(value: string): boolean {
  return value.trim() === '' || isValidSpeechLead(value);
}

export function parseStreamingSpeechEnvelope(value: string): StreamingSpeechEnvelope {
  const parsed = JSON.parse(value) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Streaming speech response must be an object.');
  }
  const record = parsed as Record<string, unknown>;
  if (
    !record.deliveryHeader ||
    typeof record.deliveryHeader !== 'object' ||
    Array.isArray(record.deliveryHeader) ||
    typeof record.speechLead !== 'string' ||
    !Array.isArray(record.speechUnits) ||
    !record.speechUnits.every((unit): unit is string => typeof unit === 'string') ||
    !Array.isArray(record.activatedCards) ||
    !record.activatedCards.every((card): card is string => typeof card === 'string')
  ) {
    throw new Error('Streaming speech response has an invalid delivery contract.');
  }
  return {
    deliveryHeader: record.deliveryHeader as Record<string, unknown>,
    speechLead: record.speechLead,
    speechUnits: record.speechUnits,
    activatedCards: record.activatedCards,
    internalDelta: record.internalDelta,
  };
}
