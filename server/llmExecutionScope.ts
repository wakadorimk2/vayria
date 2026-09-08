import { AsyncLocalStorage } from 'node:async_hooks';
import type { StructuredLlmRequest, StructuredLlmResult } from './llmRuntime.js';

// Request-local, so concurrent public users never share billing credentials or reservations.
export const llmExecutionScope = new AsyncLocalStorage<{
  execute(request: StructuredLlmRequest, run: () => Promise<StructuredLlmResult>): Promise<StructuredLlmResult>;
}>();
