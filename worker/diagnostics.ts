// Server durations only. Never accept content, credentials, or visitor identifiers.
export const timingFields = ['ttsTicketAgeMs', 'generationMs', 'firstSpeechUnitMs', 'ttsFirstByteMs', 'ttsTotalMs'] as const;
export type Measurements = Partial<Record<typeof timingFields[number], number>> & {
  llmCalls?: number; llmRetries?: number; actualModels?: string[];
};
export const metricCodes = ['tts_ticket_invalid', 'tts_ticket_expired', 'tts_ticket_session', 'complete', 'provider_failure', 'cancelled', 'limit', 'card_limit', 'user_limit',
  'autonomous_limit', 'tts_limit', 'transcribe_limit', 'audio_limit', 'daily_budget', 'monthly_budget',
  'session_expired', 'generation_stopped', 'busy', 'ticket_used', 'invalid_request', 'provider_unavailable',
  'generation_failed', 'service_unavailable', 'usage_unavailable', 'timeout'] as const;
export const safeMetricCode = (code: string) => (metricCodes as readonly string[]).includes(code) ? code : 'provider_failure';
export function sanitizeMeasurements(value: Measurements = {}): Measurements {
  const result: Measurements = {};
  for (const key of [...timingFields, 'llmCalls', 'llmRetries'] as const) {
    const n = value[key];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 86400000) result[key] = Math.round(n);
  }
  if (Array.isArray(value.actualModels)) result.actualModels = [...new Set(value.actualModels.filter(
    m => typeof m === 'string' && /^[A-Za-z0-9._:-]{1,128}$/u.test(m)))].slice(0, 8);
  return result;
}
export function distribution(values: number[]) {
  const sorted = values.filter(n => Number.isFinite(n) && n >= 0).sort((a,b) => a-b);
  return { samples: sorted.length, medianMs: sorted.length ? sorted[Math.floor(sorted.length / 2)] : null,
    p95Ms: sorted.length ? sorted[Math.ceil(sorted.length * .95) - 1] : null };
}
// The existing provider tracker calls this observer; it never changes generation decisions.
export function createGenerationMeasurements(now = () => performance.now()) {
  const started = now();
  const values: Measurements = { llmCalls: 0, llmRetries: 0 };
  const calls = new Set<string>();
  return {
    values,
    firstSpeechUnit() { values.firstSpeechUnitMs ??= Math.max(0, now() - started); },
    finish() { values.generationMs = Math.max(0, now() - started); },
    record(event: { event: string; callIndex: number; externalRequestIndex?: number; retry: number; actualModel?: string }) {
      if (event.event === 'llm_external_request_start') {
        const key = event.callIndex + ':' + event.externalRequestIndex;
        if (!calls.has(key)) { calls.add(key); values.llmCalls = calls.size;
          if (event.retry > 0) values.llmRetries = (values.llmRetries ?? 0) + 1; }
      }
      if (event.event === 'llm_external_request_done' && event.actualModel) {
        values.actualModels = sanitizeMeasurements({ actualModels: [...(values.actualModels ?? []), event.actualModel] }).actualModels;
      }
    },
  };
}
