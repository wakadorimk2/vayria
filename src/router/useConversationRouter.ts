import { useCallback, useEffect, useState } from 'react';
import { apiUrl, runtimeConfig } from '../runtimeConfig.js';
import {
  createConversationRouter,
  type ConversationRouter,
} from './conversationRouter.js';
import type {
  RouterCommand,
  RouterEffect,
  RouterEvent,
  RouterSignal,
  RouterSnapshot,
  RouterTransition,
} from './routerTypes.js';

interface UseConversationRouterOptions {
  enabled: boolean;
  onEffects?: (effects: RouterEffect[]) => void;
}

async function persistRouterEvent(event: RouterEvent): Promise<void> {
  try {
    await fetch(apiUrl('/api/router/events'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ record: event }),
      keepalive: true,
    });
  } catch {
    // Router state remains usable when local JSONL storage is unavailable.
  }
}

export function useConversationRouter({
  enabled,
  onEffects,
}: UseConversationRouterOptions) {
  const [router] = useState<ConversationRouter>(() =>
    createConversationRouter({
      onEvent: (event) => {
        if (!runtimeConfig.routerEnabled) return;
        void persistRouterEvent(event);
      },
    }),
  );
  const [snapshot, setSnapshot] = useState<RouterSnapshot>(() =>
    router.getSnapshot(),
  );

  useEffect(() => router.subscribe(setSnapshot), [router]);

  const applyTransition = useCallback((transition: RouterTransition) => {
    onEffects?.(transition.effects);
    return transition;
  }, [onEffects]);

  const dispatch = useCallback(
    (command: RouterCommand, at?: number) =>
      applyTransition(router.dispatch(command, at)),
    [applyTransition, router],
  );

  const observe = useCallback(
    (signal: RouterSignal, at?: number) =>
      applyTransition(router.observe(signal, at)),
    [applyTransition, router],
  );

  const tick = useCallback(
    (at?: number) => applyTransition(router.tick(at)),
    [applyTransition, router],
  );

  useEffect(() => {
    if (!enabled || snapshot.cooldownUntil === null) return;
    const remainingMs = Math.max(0, snapshot.cooldownUntil - Date.now());
    const timer = window.setTimeout(() => {
      tick();
    }, remainingMs);
    return () => window.clearTimeout(timer);
  }, [enabled, snapshot.cooldownUntil, tick]);

  return {
    isEnabled: enabled,
    sessionId: snapshot.sessionId,
    snapshot,
    dispatch,
    observe,
    tick,
  };
}
