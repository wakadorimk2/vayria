import { completeHandoff, prepareHandoff } from './exhibitionHandoff';
import type { PublicStatus } from './session';

export async function readRegistrationStatus(signal: AbortSignal): Promise<PublicStatus> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await fetch('/api/session', { signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]) });
    if (!response.ok) throw new Error('Status unavailable');
    const status: PublicStatus = await response.json();
    if (status.cookieReady || attempt === 1) return status;
  }
  throw new Error('Status unavailable');
}

export async function finishRegistration(epoch: number, signal: AbortSignal): Promise<void> {
  // Persist before sending so a reload retries the same participant reset.
  const request = prepareHandoff(sessionStorage, epoch);
  const response = await fetch('/api/exhibition/next', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
  });
  if (!response.ok) throw new Error('Handoff unavailable');
  await response.json();
  completeHandoff(sessionStorage);
}
