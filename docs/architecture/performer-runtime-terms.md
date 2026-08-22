# Performer Runtime terms

This table fixes the referent before each code name.

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 候補語 | 初出定義 |
|---|---|---|---|---|---|---|
| Vayria runtime design | 演者の中核 | cardを知らない実行層 | triggerをintentへ変換する | triggerの後、Directionの前 | Performer Core | VayriaとWildCardに非依存の baseline runtime |
| Vayria runtime design | 現在値の保持 | energy、emotion、attention、timestamps | live stateを保持する | Coreが読み、Result reducerが更新する | Performer State | 一時的なライブ状態 |
| Vayria runtime design | 基準傾向の保持 | initiative、inertia、gaze、decay、timing | baseline policyを提供する | StateとEffectからplanを計算する | Performer Profile | 持続的な演技傾向 |
| Vayria runtime design | 刺激の共通化 | viewer、timer、external metadata、memory | Coreへの入力契約 | 外部イベントの後、intentの前 | Performer Trigger | 外部イベントのgeneric表現 |
| Vayria runtime design | 発話または反応の候補 | speak、wait、ignore、react_nonverbally | baseline意図を表す | Triggerの後、Planの前 | Action Intent | まだ最終演技ではない候補 |
| Vayria runtime design | 番組固有の介入 | WildCard、将来のgame show | modifierとconstraintを提出する | Intentの後、resolverの前 | Live Direction | Coreを直接変更しない演出層 |
| Vayria runtime design | 介入の提出物 | effects、constraints、semantic cues | Directionの寄与を表す | Directionの実行結果 | Direction Contribution | resolverへ渡す値 |
| Vayria runtime design | 一時的または背景的な影響 | forced card、brain card | modifierのlifetimeを保持する | Contribution内で集約される | Direction Effect | intensityとdecayを持つ影響 |
| Vayria runtime design | 今回の実行 | preReaction、leadBeforeSpeechMs、speech、TTS、avatar | 実行可能な演技を表す | resolverの後、executorの前 | Performance Plan | 1回の演技計画 |
| Vayria runtime design | 音声と身体の粗い時間軸 | motionLeadMs、motionEnterBlendMs、motionExitBlendMs、motionPreparationTimeoutMs、postSpeechHoldMs | 1回のPerformance Planの再生時刻と境界補間を保持する | Performance Planに含まれ、Playback CoordinatorとMotionPlayerが読む | Performance Timing | 音声とモーションの粗粒度タイミング |
| Vayria runtime design | 通常発話の既定主動作 | `speech-gentle` の保存済みVRMA | speak planへ既定のbody motionを割り当てる | resolverの後、motion preparationの前 | Default Speech Motion Asset | 通常発話へ割り当てる保存済みVRMA |
| Vayria runtime design | 発話前の軽い反応 | `preReaction.gaze`、`IdleController`の呼吸・揺れ・首の微動 | VRMA開始前の注意移動を表現する | plan activationの後、VRMA開始の前 | Procedural Pre-Reaction | コードで生成する発話前の視線と微細なIdle動作 |
| Vayria runtime design | 音声と身体の再生調整 | prepared VRMA、音声開始予約、キャンセル、余韻 | 同じplanの再生開始と終了を調整する | Performance Planの後、Performance Resultの前 | Performance Playback Coordinator | 音声とモーションを同じ再生基準で調整する内部コンポーネント |
| Vayria runtime design | VRMAの姿勢振幅 | hips移動、hips・上体・首・頭の回転補正 | assetを変更せず、再生時の姿勢を安全側へ縮小する | clip生成の後、MotionPlayer開始の前 | Motion Playback Profile | `correctionProfileId`で選ぶ再生専用の骨別補正値 |
| Vayria runtime design | 実行結果 | spoken text、emotion cue、outcome | State reducerへ返す | speech / TTS / avatarの後 | Performance Result | planの完了・中断・失敗結果 |

## Naming rules

- `card_insert` is a WildCard input term. It is not a Performer Core trigger.
- `external_stimulus` is the generic Core trigger for non-viewer external events.
- external stimulus metadata is opaque to Performer Core.
- `modifyIntent()` is not a Live Direction API.
- `responseDelayMs` belongs to a plan, not to live State.
- `leadBeforeSpeechMs` starts after plan activation and delays the speech pipeline.
- `motionLeadMs` starts prepared body motion before audio playback.
- `motionEnterBlendMs` raises VRMA weight from zero at the motion start boundary.
- `motionExitBlendMs` lowers VRMA weight after the post-speech hold.
- `speech-gentle` is the default saved body motion for ordinary speech.
- `Procedural Pre-Reaction` uses gaze and small Idle motion before the saved body motion.
- `motionPreparationTimeoutMs` bounds the wait for prepared motion.
- `postSpeechHoldMs` keeps the body pose before Idle resumes.
- Idle and VRMA crossfade only at the start and end boundaries. VRMA is the only body-motion layer during the main playback.
- `MotionPlaybackProfile` preserves the first hips position, attenuates selected bone rotations, and leaves arms, legs, and expressions unchanged.
- topic remains conversation-owned in v0.1.
- `emotionCue` is a proposal from LLM or a plan. It is not the final persistent emotion.
