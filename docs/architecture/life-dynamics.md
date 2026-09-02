# LifeDynamics design

## Status

This document defines the design baseline for LifeDynamics in issue #65.

LifeDynamics is now the default session-scoped avatar runtime.
The default path creates the Life, Blink, and Orienting adapters.
Gesture remains internal temporal state and has no rendering adapter.
The default path does not create `MotionPlayer` or the legacy `BlinkController`.
Use `?life-dynamics=legacy` to restore the retained Idle, Blink, and VRMA path.
The legacy `?life-dynamics-poc=1` input remains compatible but no longer enables a separate mode.

Issue #66 remains the parent issue for the wider performer architecture.
Issue #64 covers autonomous speech timing.
The implementation PoC will use a separate follow-up issue.

The public Performer State and gaze target formats remain unchanged.
The VRMA types, assets, and public handles remain available for rollback compatibility.

## Ownership boundary

The design separates semantic state, temporal body state, and VRM actuation.

| Layer | Owns | Does not own |
| --- | --- | --- |
| Performer State | The current semantic, performative, and perceptual state | Body phase, oscillator history, or VRM mutation |
| LifeDynamics | Continuous temporal state for procedural modalities | Meaning selection, speech content, or direct Performer State mutation |
| Adapter | VRM expressions, LookAt, bone transforms, and AnimationMixer operations | The source temporal state |
| VRMA / MotionPlayer | Authored base pose and large body motion during playback | LifeDynamics state or procedural policy |

The current `PerformerState` is defined in [`src/performer/types.ts`](../../src/performer/types.ts#L147).
It contains live values such as energy, emotion, attention, and speech timestamps.
The current React bridge is [`usePerformerRuntime`](../../src/performer/usePerformerRuntime.ts#L25).
Its `resetRuntime` path resets the existing Performer State.

LifeDynamics holds how the performer state evolves through the body over time.
LifeDynamics does not write back into Performer State.
It reads Performer State and related perception, conversation, and performance context as input or modulation.

The temporal state owned by LifeDynamics includes the following categories:

- oscillator phase and velocity;
- damping and transition state;
- noise state;
- recent history used for cross-modal coupling;
- Blink, Orienting, and Gesture timing state;
- Life timing state for breathing and micro-sway.

The design treats `IdleController`, `IdleGazeController`, and `BlinkController` as current implementation boundaries.
Their future migration target is an Adapter that consumes LifeDynamics output.
The migration does not happen in this design-only change.

## Initial signal boundary

The initial LifeDynamics signal set is limited to the following signals:

```text
arousal
curiosity
attention[target]
speechUrge
inhibition
```

Existing Performer State values such as `energy` and `emotion` are input or modulation values.
Intent and performance-plan context are also inputs.
They are not new independent LifeDynamics signals in the initial design.

The following names remain future candidates from the parent architecture:

```text
valence
engagement
internal_attention
social_orientation
```

The initial design does not mix these future candidates with the initial signal set.
The design also does not fix signal equations, coefficients, half-lives, or noise distributions.
Those decisions belong to the follow-up PoC.

## Time advancement and snapshot boundary

The Avatar clock owns frame timing.
The session controller calls LifeDynamics with the frame delta.
LifeDynamics owns the state transition.
Adapters apply the resulting snapshot to the avatar.

```text
Performer State / perception / conversation / performance context
                         ↓ input / modulation
                    Avatar clock
                         ↓ dt
                 session controller
                         ↓ update(dt, inputs)
                    LifeDynamics
        phase / velocity / damping / noise / history
                         ↓ immutable snapshot
       LifeAdapter | BlinkAdapter | OrientingAdapter | GestureAdapter
                         ↓
       VRM expressions | LookAt | bones | AnimationMixer
```

The conceptual contract is:

```text
update(dt, inputs) → immutable snapshot
```

This is a documentation contract.
It is not a TypeScript interface in this change.

The snapshot must not expose mutable internal state.
An Adapter must not mutate LifeDynamics through the snapshot.
An Adapter must not mutate Performer State through the snapshot.

Session Reset clears the complete LifeDynamics history.
The reset includes phase, velocity, damping state, noise state, transition state, and recent history.
The reset also clears pending cross-modal transitions.

## Procedural modality ownership

LifeDynamics directly owns the timing and temporal state of all procedural modalities.
The Adapters own only the final body actuation.

| Modality | LifeDynamics owns | Adapter applies |
| --- | --- | --- |
| Life | Breathing phase, sway phase, velocity, damping, and noise | Bounded offsets for breathing and micro-sway |
| Blink | Blink phase, hold, open, close, and refractory timing | VRM eye expression weights |
| Orienting | Target transition, attention transfer, and head-eye timing | LookAt, eye rotation, neck, and head correction |
| Gesture | Onset, sustain, decay, and interruption timing | Masked animation or bounded bone motion |

Gesture meaning and asset selection remain inputs from Performance State or Performance Plan.
LifeDynamics decides temporal evolution after it receives that input.
It does not invent semantic dialogue content.

The shared owner enables future coupling between modalities.
Examples include a blink near a gaze transition, a gesture onset near speech start, and delayed head-to-eye attention transfer.
These couplings are design targets.
They are not implemented or parameterized here.

## VRMA and procedural layers

VRMA and procedural modalities do not have equal ownership of the same motion channels.
The intended layer order is:

```text
VRMA
  ↓ base pose and large authored body motion
Life
  ↓ breathing and micro-sway
Orienting
  ↓ gaze, head, and limited upper-body correction
Gesture
  ↓ meaningful masked movement
Constraints / ownership
  ↓
Final Pose
```

The ownership rules are:

| Channel | M1 owner | Future procedural rule |
| --- | --- | --- |
| root, hips, legs | VRMA | No procedural ownership by default; allow only a bounded, validated exception |
| spine, chest | VRMA base | Life may add a bounded offset after PoC validation |
| neck, head | VRMA base with Orienting priority | Orienting owns the gaze-related correction |
| eyes | Avatar look-at system | Orienting owns target transition and limits |
| arms, hands | VRMA or no overlay | Gesture requires an explicit mask and ownership declaration |

Every future merge must define bone ownership, a mask, and an angle limit.
The merge must preserve the VRMA asset.
The merge must not silently replace an authored VRMA track.

The current M1 rule remains in force:

- VRMA is the main body-motion layer during playback.
- Idle and VRMA crossfade only at their existing boundaries.
- The design does not enable a new LifeDynamics overlay during main VRMA playback.
- `MotionPlayer` continues to apply the existing playback profile and lifecycle.

The current VRMA boundary is documented in [`performer-runtime.md`](performer-runtime.md).
The current player is [`MotionPlayer`](../../src/avatar/motion/motionPlayer.ts#L61).
The current frame integration is in [`VrmStage`](../../src/avatar/VrmStage.tsx#L168).

## Lifecycle and interruption

The session controller creates one LifeDynamics state for one avatar session.
The Avatar clock advances it while the avatar is active.
Session Reset resets it before the new session consumes input.

Viewer speech, active Performance Plans, VRMA playback, and existing safety gates remain existing runtime constraints.
LifeDynamics does not bypass those constraints.
It produces procedural state only after the session controller provides the current inputs and mode.

When a mode interrupts a procedural transition, the session controller records the interruption in LifeDynamics state.
The next update resumes or returns according to the future PoC policy.
This document does not select a recovery curve.

## Non-goals

This change does not:

- add `LifeDynamics` code;
- change `PerformerState`, `PerformancePlan`, or any public TypeScript type;
- replace the current avatar Controllers;
- change VRMA loading, playback, or correction profiles;
- enable procedural offsets during M1 VRMA playback;
- choose signal equations or numeric parameters;
- create the follow-up PoC issue;
- edit GitHub Issue #65.

## Follow-up PoC inputs

The follow-up PoC must test the following before runtime adoption:

- deterministic clock and reset behavior;
- immutable snapshot behavior;
- coupling between Blink, Orienting, Gesture, and Life;
- interruption and recovery behavior;
- bone ownership, masks, and angle limits;
- VRMA playback safety;
- perceptual difference from the current M1 behavior.

The PoC must keep the current VRMA playback path as the control condition.

## References

- [Performer runtime architecture](performer-runtime.md)
- [Performer runtime terms](performer-runtime-terms.md)
- [Autonomy timing research](../evaluation/autonomy-timing-research.md)
- [Issue #65](https://github.com/wakadorimk2/vayria/issues/65)
