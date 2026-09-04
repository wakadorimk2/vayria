# Vayria Mission Control

- Target: 2026-09-23 Exhibition
- Reviewed: 2026-09-04
- Phase: 2/5 Experience Push

## Phases

- 成立
- Experience Push
- Selection
- Polish & Freeze
- Exhibition

## Now

- 🔥 [Experience Push Tracker #80](https://github.com/wakadorimk2/vayria/issues/80) — Speed、Conversation、Cardを実装済み。残るEmbodimentをSelectionへ渡せる状態にする
- ⚡ Speed — [LLM #83](https://github.com/wakadorimk2/vayria/issues/83)は現状十分として完了。[TTS #78](https://github.com/wakadorimk2/vayria/issues/78)で展示用PC、本番予定network、failure recoveryを確認する
- 💬 Conversation — [Issue #23](https://github.com/wakadorimk2/vayria/issues/23)の実機・復帰条件を確認し、[Issue #87](https://github.com/wakadorimk2/vayria/issues/87)でセッション内記憶が会話の自然さへ与える効果を検証する
- 👀 [Embodiment #79](https://github.com/wakadorimk2/vayria/issues/79) — 発話開始時の視線、表情、モーションを一つの身体反応として尖らせる
- 🛡 [Guardrails #21](https://github.com/wakadorimk2/vayria/issues/21)・[#24](https://github.com/wakadorimk2/vayria/issues/24)・[#25](https://github.com/wakadorimk2/vayria/issues/25) — 実環境再現性、表情・音声競合、性能・復帰・安全なログの下限を維持する

## Next

- → 9/8〜12: [Issue #29](https://github.com/wakadorimk2/vayria/issues/29) で4候補をSmoke Testし、[Issue #30](https://github.com/wakadorimk2/vayria/issues/30) で候補ごとにKeep/Dropを決める。採用数に上限は設けない
- → 9/13〜17: [Issue #31](https://github.com/wakadorimk2/vayria/issues/31) でKeepした体験を磨き、Go/No-Goを確定する
- → 9/17まで: [Issue #27](https://github.com/wakadorimk2/vayria/issues/27) と [Issue #28](https://github.com/wakadorimk2/vayria/issues/28) へ運用手順と搬入準備を反映する
- → 9/18: [Issue #32](https://github.com/wakadorimk2/vayria/issues/32) でHard Freezeする
- → 9/19〜22: [Issue #26](https://github.com/wakadorimk2/vayria/issues/26) で最終Owner Playcheckを行う

## Recently Done

- [PR #86](https://github.com/wakadorimk2/vayria/pull/86) LLM provider単位のレイテンシ計測を追加した
- [PR #85](https://github.com/wakadorimk2/vayria/pull/85) viewer activityへ適応する自律発話タイミング候補を追加した
- [PR #84](https://github.com/wakadorimk2/vayria/pull/84) card drop時の視線、非言語反応、返答をつなぐ候補を追加した
- [PR #75](https://github.com/wakadorimk2/vayria/pull/75) LifeDynamicsを通常経路へ採用し、カードdrag時の視線追従を修正した
- [PR #82](https://github.com/wakadorimk2/vayria/pull/82) Aivis Cloud streamingとTTFA比較経路を追加した
- [PR #81](https://github.com/wakadorimk2/vayria/pull/81) PROJECT.mdを正本とするMission Controlローカルビューを追加した
