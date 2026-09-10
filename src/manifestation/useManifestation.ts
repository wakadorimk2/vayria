import { publicFetch, publicSessionId } from '../public/session';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { ManifestationSession } from './session';
import { prepareObject, releasePrepared } from './media';
import type { GeneratedObject, InputEvent } from './types';
import { runtimeConfig } from '../runtimeConfig';

export function useManifestation() {
  const [client] = useState(() => {
    let experiment: Promise<string> | null = null;
    let experimentGeneration = 0;
    let lastFallback = -1;
    const getExperiment = () => {
      if (experiment) return experiment;
      const generation = experimentGeneration;
      return experiment = (async () => {
      const saved = localStorage.getItem('manifestation-experiment');
      if (saved && /^[\w-]{36}$/.test(saved)) return saved;
      const response = await fetch('/api/manifestation/experiments', { method: 'POST' });
      if (!response.ok) throw new Error('experiment-unavailable');
      const value = await response.json() as { experimentId: string };
      if (generation === experimentGeneration) localStorage.setItem('manifestation-experiment', value.experimentId);
      return value.experimentId;
    })().catch(error => { if (generation === experimentGeneration) experiment = null; throw error; });
    };
    const runtime = new ManifestationSession(crypto.randomUUID(), {
      now: Date.now,
      applyCard: () => false,
      fallback: () => {
        lastFallback = lastFallback < 0 ? Math.floor(Math.random() * 3) : (lastFallback + 1 + Math.floor(Math.random() * 2)) % 3;
        return { url: `/manifestation/chicken-${lastFallback + 1}.png`, kind: 'image', composite: 'alpha', mode: 'static-fallback', timings: {} };
      },
      prepare: prepareObject,
      discard: media => releasePrepared(media.url),
      generate: async (event, signal) => {
        const browserOrigin = performance.now();
        const experimentId = runtimeConfig.mode === 'public' ? publicSessionId() : await getExperiment(); signal.throwIfAborted();
        const response = await publicFetch('/api/manifestation/generate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ experimentId, event }), signal });
        if (!response.ok) { const value = await response.json() as { error?: string }; throw new Error(value.error ?? 'generation-unavailable'); }
        const result = await response.json() as GeneratedObject;
        if (result.trace) { result.trace.browserOrigin = browserOrigin; result.trace.browser.responseReceived = performance.now() - browserOrigin; }
        return result;
      },
    });
    return { runtime, newExperiment: () => {
      runtime.reset(); experimentGeneration++; experiment = null; localStorage.removeItem('manifestation-experiment');
    } };
  });
  const { runtime } = client;
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot);
  const bind = useCallback((apply: (event: InputEvent) => boolean, displayed: (id: string, description: string) => void) => runtime.bind(apply, displayed), [runtime]);
  useEffect(() => {
    if (!runtimeConfig.manifestationEnabled) return;
    for (let i = 1; i <= 3; i++) { const image = new Image(); image.src = `/manifestation/chicken-${i}.png`; }
    const timer = window.setInterval(() => runtime.tick(), 100);
    return () => { clearInterval(timer); runtime.reset(); };
  }, [runtime]);
  useEffect(() => {
    const urls = new Set(snapshot.objects.map(o => o.url));
    // Completed/retired videos no longer hold decoder resources.
    return () => { urls.forEach(url => { if (!runtime.getSnapshot().objects.some(o => o.url === url)) releasePrepared(url); }); };
  }, [runtime, snapshot.objects]);
  return { runtime, snapshot, bind, newExperiment: client.newExperiment };
}
