# AI Performer Runtime v0.1

## Status

This document describes the implemented v0.1 runtime boundary.

WildCard is a `Live Direction`.

The performer runtime is the product core.

The runtime does not contain WildCard-specific concepts.

## 1. Current architecture

### Current request flow

```text
App.tsx
  ├─ viewer input
  ├─ card insert
  └─ autonomous timer
       ↓
useConversation
       ├─ /api/chat
       ├─ /api/tts
       └─ audio playback
       ↓
VrmStage
```

Before v0.1, `useConversation` owned conversation state, emotion reset, TTS, and cancellation.

Before v0.1, cards were sent as card IDs and prompt instructions.

Before v0.1, `useAutonomousTalk` selected the fixed 4-second and 8–18-second timer distribution.

### v0.1 integration boundary

```text
viewer / timer
      ↓
Performer Core
      ↓
Action Intent
      ↓
Direction Contributions
      ↓
central resolver
      ↓
Performance Plan
      ↓
useConversation / TTS / avatar
      ↓
Performance Result
      ↓
Performer State reducer
```

The current source mapping is:

| Responsibility | Implementation |
|---|---|
| Performer state and policy | `src/performer/types.ts`, `src/performer/profile.ts` |
| Baseline intent and plan resolver | `src/performer/runtime.ts` |
| React state bridge | `src/performer/usePerformerRuntime.ts` |
| WildCard direction | `src/cards/wildcardDirection.ts` |
| Request and playback execution | `src/conversation/useConversation.ts` |
| Autonomous timer and environment checks | `src/conversation/useAutonomousTalk.ts` |
| LLM and TTS provider boundary | `server/localApi.ts` |
| Expression, gaze approximation, and idle motion | `src/avatar/VrmStage.tsx`, `src/avatar/idleMotion.ts` |

### Exhibition observability

`useConversation` emits one event stream for each conversation turn.
The stream includes input, LLM, TTS, playback, and terminal events.
Each event has a turn ID and excludes message text, reply text, history, and secrets.

Provider requests carry the same turn ID through `X-Wildcard-Turn-Id`.
The Vite local API accepts development events at `/api/events` and logs provider concurrency.
The exhibition stress test uses the same chat and TTS endpoints with deterministic input.

## 2. Core boundary

### Performer Core

The Core accepts only generic triggers.

```ts
type PerformerTrigger =
  | { kind: 'viewer_message'; text: string }
  | { kind: 'idle_tick'; elapsedMs: number }
  | {
      kind: 'external_stimulus';
      semanticCue: string;
      metadata?: Readonly<Record<string, string>>;
    }
  | { kind: 'memory_callback'; semanticCue: string };
```

`card_insert` does not exist in the Core type.

The Core does not interpret external stimulus metadata.
WildCard translates a card insertion into `external_stimulus` and submits
`{ origin: 'wildcard' }` as opaque metadata.

The baseline intent for `external_stimulus` is `react_nonverbally`.
WildCard adds `require_speech` and `attentionTarget: 'viewer'` through its Direction Contribution.

The same boundary can receive a game event, a tip, or a system event later.

### React boundary

`useAutonomousTalk` measures timer readiness, visibility, mute state, and busy state.

It calls `getNextAutonomousDelay()`.

The Performer Runtime applies initiative and energy.

The hook does not decide whether the performer wants to speak.

`useConversation` executes requests and playback.

It emits `PerformanceResult`.

It does not own emotion state.

## 3. State and profile

### Performer State

`PerformerState` stores live state:

- phase
- energy
- emotion value and activation
- attention target and strength
- last speech timestamp
- last viewer message timestamp

`responseDelayMs` is not state.

The resolver calculates it for each `PerformancePlan`.

Topic is conversation-owned in v0.1.
`App.tsx` and `useConversation` keep `AutonomousContext`, `topic`, and `topicTurns`.
Moving topic into the Runtime is a v0.2 decision.

### Performer Profile

`PerformerProfile` stores baseline policy:

- initiative baseline
- emotional inertia
- speech fragmentation baseline
- callback tendency baseline
- gaze directness baseline
- emotion and attention half-life
- energy baseline
- response and pre-reaction timing
- autonomous timing distribution

The default profile preserves the previous exhibition timing as its starting point.

Cards modify the effective profile for a plan.

## 4. Action Intent and Performance Plan

`createActionIntent()` applies the baseline performer policy.

Examples:

- `viewer_message` prefers `speak`.
- `idle_tick` can choose `speak`, `react_nonverbally`, or `ignore`.
- a generic external stimulus prefers a non-verbal reaction.
- a Direction constraint can resolve an external stimulus to speech.

`resolvePerformancePlan()` is the only final plan resolver.

Live Directions do not mutate `ActionIntent`.

```ts
interface DirectionContribution {
  directionId: string;
  effects: DirectionEffect[];
  constraints: DirectionConstraint[];
  semanticCues: string[];
  triggers: PerformerTrigger[];
  attentionTarget?: 'viewer' | 'chat' | 'game' | 'none';
}
```

The resolver performs these steps:

1. Calculate active effect intensity.
2. Aggregate numeric modifiers from every Direction.
3. Aggregate semantic cues.
4. Evaluate constraints.
5. Clamp numeric values once.
6. Create one `PerformancePlan`.

The result does not depend on Direction execution order.

`PerformancePlan` can represent a reaction before speech.

```text
viewer message
      ↓ t=0
gaze / idle motion reaction starts
      ↓ response delay
LLM → TTS → playback
```

`leadBeforeSpeechMs` is the lead time from plan activation to `/api/chat`.

The v0.1 plan does not implement a general timeline engine.

TTS and avatar profiles are optional for non-speech plans.

## 5. Performance Result and state transition

`useConversation` emits a result for completed, cancelled, interrupted, and failed plans.

The result includes the plan ID, trigger kind, intent, outcome, spoken text when available, and the LLM emotion cue.

`usePerformerRuntime.completePlan()` calls the pure `reducePerformanceResult()` function.

The reducer applies these rules:

- emotion does not reset to neutral at turn start;
- emotion activation decays by half-life;
- the LLM emotion cue is blended with previous emotion using inertia;
- cancelled and interrupted plans do not count as completed speech;
- failed plans return the phase to `idle`;
- viewer messages update attention to `viewer`;
- completed autonomous speech slightly lowers energy;
- completed speech updates `lastSpeechAt`.

The active LLM cue can drive the avatar during the current plan.

The reducer preserves the cue as persistent Performer State after the plan completes.

Audio completion does not force the emotion back to `neutral`.
The avatar uses the current Performer State after the active plan is cleared.

## 6. WildCard Live Direction

`src/cards/wildcardDirection.ts` is the first `Live Direction` implementation.

It owns card semantics and card lifetimes.

### Effect lifecycle

| Effect | Initial intensity | Lifetime |
|---|---:|---|
| forced card effect | 1.0 | exponential decay for 30 seconds |
| brain background effect | 0.2 | while the card remains in the brain |

Forced and background effects can coexist for the same card.

Effect aggregation is additive.

The resolver clamps the result once.

### Observable modifier examples

| Card | Policy | Speech / TTS | Avatar |
|---|---|---|---|
| 疑心暗鬼 | emotional inertia up, response delay up | fragmentation up, intonation down | gaze directness down |
| 眠い | initiative down | rate and intonation down | idle motion weight down |
| 好奇心 | initiative and callback tendency up | intonation slightly up | gaze directness up |

The card still provides prompt-level semantic cues to the LLM.

The card also changes delay, TTS, attention, gaze, and motion policy.

`require_speech` is a WildCard contribution.

It is not a Performer Core rule.

## 7. Request and event flow

### Viewer message

```text
submit
  ↓
viewer_message trigger
  ↓
WildCard contribution
  ↓
Performance Plan
  ↓
leadBeforeSpeechMs: body reaction starts at t=0
  ↓
/api/chat with performanceContext
  ↓
/api/tts with ttsProfile
  ↓
audio playback
  ↓
PerformanceResult
  ↓
Performer State reducer
```

### Card insertion

```text
card inserted
  ↓
WildCard creates forced effect and generic external_stimulus
  ↓
WildCard adds require_speech and attentionTarget: viewer
  ↓
Performer Core creates intent
  ↓
central resolver creates Performance Plan
```

### Autonomous tick

```text
timer readiness
  ↓
getNextAutonomousDelay()
  ↓
idle_tick
  ↓
initiative + energy
  ↓
speak / wait / ignore / non-verbal reaction
```

If the plan does not speak, the runtime completes a non-speech plan locally.

If the plan speaks, `useConversation` performs the LLM and TTS request.

### Interruption and stale work

Manual input cancels an autonomous plan before the new manual plan starts.

The conversation generation guard rejects stale fetch and playback completions.

The active plan ID guard rejects stale `PerformanceResult` updates.

## 8. Prior art and Build / Buy / Borrow decision

These findings are based on the inspected repository paths and source files.

### AILiveVTuber-Stage

Borrow the ideas of a priority response queue, explicit FSM phases, attention states, and prepare/execute separation.

Do not add the repository as a runtime dependency.

The repository is MIT licensed.

- [technical overview](https://github.com/KKLL2025/AILiveVTuber-Stage/blob/main/TECHNICAL_OVERVIEW.md)
- [response queue](https://github.com/KKLL2025/AILiveVTuber-Stage/blob/main/livevtuber/response_queue.py)
- [FSM](https://github.com/KKLL2025/AILiveVTuber-Stage/blob/main/livevtuber/action/fsm.py)
- [attention](https://github.com/KKLL2025/AILiveVTuber-Stage/blob/main/livevtuber/consciousness/attention.py)
- [license](https://github.com/KKLL2025/AILiveVTuber-Stage/blob/main/LICENSE)

### Open-LLM-VTuber

Borrow proactive trigger metadata, task cancellation, partial speech handling, and sentence-level TTS scheduling.

Do not import the runtime for v0.1.

The repository is MIT licensed.

- [conversation handler](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/conversations/conversation_handler.py)
- [TTS manager](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/src/open_llm_vtuber/conversations/tts_manager.py)
- [license](https://github.com/Open-LLM-VTuber/Open-LLM-VTuber/blob/main/LICENSE)

### Shikigami Protocol

Use persistent state, emotion engine, Reflection, ASE, and memory callback as design references.

Do not directly use the repository.

The repository is AGPL-3.0 licensed.

The long-term state model is outside the 9/23 MVP.

- [architecture](https://github.com/Shikigami-Lab/Shikigami-Protocol/blob/main/assets/readme/architecture.mmd)
- [emotion engine](https://github.com/Shikigami-Lab/Shikigami-Protocol/blob/main/src/engines/emotion_engine.py)
- [license](https://github.com/Shikigami-Lab/Shikigami-Protocol/blob/main/LICENSE)

### AIRI

Borrow queue and cancellation concepts from the audio pipeline.

Borrow the idle blink, look-at, and eye-saccade direction for future avatar work.

Do not add a direct AIRI dependency.

The repository is MIT licensed.

The current MVP uses the existing VRM stage and a small head-yaw gaze approximation.

- [chat orchestrator](https://github.com/moeru-ai/airi/blob/main/packages/core-agent/src/runtime/chat-orchestrator-runtime.ts)
- [speech pipeline](https://github.com/moeru-ai/airi/blob/main/packages/pipelines-audio/src/speech-pipeline.ts)
- [VRM animation](https://github.com/moeru-ai/airi/blob/main/packages/stage-ui-three/src/composables/vrm/animation.ts)
- [license](https://github.com/moeru-ai/airi/blob/main/LICENSE)

## 9. MVP boundary for 9/23

### Performer MVP

- persistent emotion across turns;
- emotion activation decay;
- pre-reaction before speech;
- initiative-controlled autonomous cadence;
- baseline attention target and gaze;
- Performance Result to State transition.

### WildCard MVP

- card insertion creates a Direction Effect;
- forced effect decays for approximately 30 seconds;
- brain effects remain while cards stay in the brain;
- 疑心暗鬼 changes delay, inertia, fragmentation, TTS, and gaze;
- 眠い changes initiative and speech energy;
- 好奇心 changes initiative, callback tendency, and gaze;
- card-specific `require_speech` stays in WildCard.

### Not now

- long-term memory, RAG, and vector search;
- Reflection, ASE, and inner monologue;
- trust, affinity, and durable personality growth;
- generic timeline engine;
- speech queue, sentence-level TTS, barge-in, and resume;
- VRMA selection and complex motion graphs;
- arbitrary card DSL;
- direct dependency on an external OSS runtime.

## 10. Implementation issues

The implementation is organized around these boundaries:

1. `WILD-PERFORMER-01`: Core, State, Profile, generic Trigger, baseline policy, autonomous delay.
2. `WILD-PERFORMANCE-02`: Intent, Plan, pre-reaction, Result, State reducer.
3. `WILD-DIRECTION-03`: Direction Contribution, Effect, Constraint, central resolver.
4. `WILD-WILDCARD-04`: card translation, card modifiers, effect lifecycle, WildCard constraint.
5. `WILD-AVATAR-05`: gaze, expression hold, idle motion weight, pre-reaction executor.
6. `WILD-EXHIBITION-06`: baseline comparison, owner playcheck, exhibition calibration.

The current code implements the vertical slice for all six boundaries.

## 11. Risks and open questions

### Known risks

- The current audio path still plays one complete WAV at a time.
- The current VRM gaze implementation uses head-yaw bias, not a full eye target controller.
- The current LLM contract still contains WildCard card validation in the local API.
- Topic remains conversation-owned in v0.1. Runtime topic ownership is a v0.2 migration.
- Energy and attention modifiers are plan-local in v0.1. Persistent impulses need a separate contract.
- React hook callback ref synchronization occurs in an effect, so a callback should not be changed during an in-flight render.

### Open questions

- Should `attention.target` become a typed target object for game and multi-viewer contexts?
- Should `PerformancePlan` become a discriminated union after the exhibition?
- Should the next step add a queue, or should a higher-level show director own queue policy?
- Should emotion decay use one half-life or separate positive and negative half-lives?
- Should card modifiers move from a TypeScript map to data files after the card vocabulary stabilizes?

## 12. Verification contract

Pure Runtime tests compile the NodeNext-compatible runtime modules into
`node_modules/.tmp/performer-test` and run with Node's built-in test runner.
`npm test` runs these tests before the exhibition stress test.

The following checks are required for future changes:

- `card_insert` is absent from Performer Core types and implementation.
- no `modifyIntent()` exists on Live Direction.
- initiative decisions stay outside `useAutonomousTalk`.
- state changes use `PerformanceResult` and the reducer.
- no-card baseline still speaks, waits, and reacts.
- `PerformancePlan` activation starts gaze and motion at t=0.
- `leadBeforeSpeechMs` delays `/api/chat` after the body reaction begins.
- effect result does not depend on contribution order.
- `require_speech` remains a WildCard contribution.
- stale generation, cancellation, and TTS failure return safely to `idle`.
