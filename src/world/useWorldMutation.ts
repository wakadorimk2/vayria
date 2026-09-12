import { useEffect, useState, useSyncExternalStore } from 'react';
import { apiUrl } from '../runtimeConfig';
import { WorldRuntime } from './worldRuntime';
export function useWorldMutation() {
  const [runtime] = useState(() => new WorldRuntime({
    now: Date.now, id: () => crypto.randomUUID(), random: Math.random,
    readExperiment: () => { try { return localStorage.getItem('vayria-world-experiment'); } catch { return null; } },
    saveExperiment: id => { try { localStorage.setItem('vayria-world-experiment', id); } catch { /* Memory still retains the experiment. */ } },
    async post(path, value, signal) {
      const response = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.error ?? '世界変換に失敗しました。'), { attempts: result.attempts });
      return result;
    },
    async stream(request, signal, receive) {
      const response = await fetch(apiUrl('/api/world/mutate'), { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' }, body: JSON.stringify(request), signal });
      if (!response.ok) { const error = await response.json(); throw Object.assign(new Error(error.error), { attempts: error.attempts }); }
      if (!response.body) throw new Error('世界生成の応答がありません。');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let buffer = '', complete = false;
      try {
        while (true) {
          const { value, done } = await reader.read();
          buffer += decoder.decode(value, { stream: !done });
          if (buffer.length > 32_000_000) throw new Error('世界生成の応答が大きすぎます。');
          let newline: number;
          while ((newline = buffer.indexOf('\n')) !== -1) {
            const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            await receive(event);
            if (event.type === 'done') complete = true;
          }
          if (done) break;
        }
        if (!complete) throw new Error('世界生成の接続が途中で切れました。');
      } finally { reader.releaseLock(); }
    },
    loadImage: (url, signal) => new Promise<void>((resolve, reject) => {
      const image = new Image();
      const cleanup = () => { image.onload = null; image.onerror = null; signal.removeEventListener('abort', abort); };
      const abort = () => { cleanup(); image.src = ''; reject(new Error('Cancelled')); };
      image.onload = () => { cleanup(); resolve(); };
      image.onerror = () => { cleanup(); reject(new Error('生成画像を表示できませんでした。')); };
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else image.src = url;
    }),
  }));
  const snapshot = useSyncExternalStore(runtime.subscribe, runtime.getSnapshot, runtime.getSnapshot);
  useEffect(() => () => runtime.dispose(), [runtime]);
  return { runtime, snapshot };
}
