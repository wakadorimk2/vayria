# Performer Runtime terms

This table fixes the referent before each code name.

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 候補語 | 初出定義 |
|---|---|---|---|---|---|---|
| WildCard runtime design | 演者の中核 | cardを知らない実行層 | triggerをintentへ変換する | triggerの後、Directionの前 | Performer Core | WildCard非依存の baseline runtime |
| WildCard runtime design | 現在値の保持 | energy、emotion、attention、topic、timestamps | live stateを保持する | Coreが読み、Result reducerが更新する | Performer State | 一時的なライブ状態 |
| WildCard runtime design | 基準傾向の保持 | initiative、inertia、gaze、decay、timing | baseline policyを提供する | StateとEffectからplanを計算する | Performer Profile | 持続的な演技傾向 |
| WildCard runtime design | 刺激の共通化 | viewer、timer、game、tip、memory | Coreへの入力契約 | 外部イベントの後、intentの前 | Performer Trigger | 外部イベントのgeneric表現 |
| WildCard runtime design | 発話または反応の候補 | speak、wait、ignore、react_nonverbally | baseline意図を表す | Triggerの後、Planの前 | Action Intent | まだ最終演技ではない候補 |
| WildCard runtime design | 番組固有の介入 | WildCard、将来のgame show | modifierとconstraintを提出する | Intentの後、resolverの前 | Live Direction | Coreを直接変更しない演出層 |
| WildCard runtime design | 介入の提出物 | effects、constraints、semantic cues | Directionの寄与を表す | Directionの実行結果 | Direction Contribution | resolverへ渡す値 |
| WildCard runtime design | 一時的または背景的な影響 | forced card、brain card | modifierのlifetimeを保持する | Contribution内で集約される | Direction Effect | intensityとdecayを持つ影響 |
| WildCard runtime design | 今回の実行 | preReaction、speech、TTS、avatar | 実行可能な演技を表す | resolverの後、executorの前 | Performance Plan | 1回の演技計画 |
| WildCard runtime design | 実行結果 | spoken text、emotion cue、outcome | State reducerへ返す | speech / TTS / avatarの後 | Performance Result | planの完了・中断・失敗結果 |

## Naming rules

- `card_insert` is a WildCard input term. It is not a Performer Core trigger.
- `external_stimulus` is the generic Core trigger for non-viewer external events.
- `modifyIntent()` is not a Live Direction API.
- `responseDelayMs` belongs to a plan, not to live State.
- `emotionCue` is a proposal from LLM or a plan. It is not the final persistent emotion.
