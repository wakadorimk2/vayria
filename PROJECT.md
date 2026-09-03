# Vayria Mission Control

- Target: 2026-09-23 Exhibition
- Reviewed: 2026-09-03
- Phase: 2/5 Experience Push

## Phases

- 成立
- Experience Push
- Selection
- Polish & Freeze
- Exhibition

## Now

- 🔥 [Experience Push Tracker #80](https://github.com/wakadorimk2/vayria/issues/80) — 9/7までに新しい展示価値を4つ実装し、同じ証拠基準でSelectionへ渡す
- ⚡ Speed — [TTS #78](https://github.com/wakadorimk2/vayria/issues/78)でAivis Cloudとlocal TTSを比較し、[LLM #83](https://github.com/wakadorimk2/vayria/issues/83)でprovider計測とinteractive pathの発話開始を短縮する
- 💬 [Conversation #23](https://github.com/wakadorimk2/vayria/issues/23) — [研究 #64](https://github.com/wakadorimk2/vayria/issues/64)を入力に、viewer activityへ適応する自律発話タイミングを実装する
- 🃏 [Card #22](https://github.com/wakadorimk2/vayria/issues/22) — card dropから視線、非言語反応、返答までに一つの「おっ」を作る
- 👀 [Embodiment #79](https://github.com/wakadorimk2/vayria/issues/79) — 発話開始時の視線、表情、モーションを一つの身体反応として尖らせる
- 🛡 [Guardrails #21](https://github.com/wakadorimk2/vayria/issues/21)・[#24](https://github.com/wakadorimk2/vayria/issues/24)・[#25](https://github.com/wakadorimk2/vayria/issues/25) — 実環境再現性、表情・音声競合、性能・復帰・安全なログの下限を維持する

## Next

- → 9/8〜12: [Issue #29](https://github.com/wakadorimk2/vayria/issues/29) で4候補をSmoke Testし、[Issue #30](https://github.com/wakadorimk2/vayria/issues/30) で候補ごとにKeep/Dropを決める。採用数に上限は設けない
- → 9/13〜17: [Issue #31](https://github.com/wakadorimk2/vayria/issues/31) でKeepした体験を磨き、Go/No-Goを確定する
- → 9/17まで: [Issue #27](https://github.com/wakadorimk2/vayria/issues/27) と [Issue #28](https://github.com/wakadorimk2/vayria/issues/28) へ運用手順と搬入準備を反映する
- → 9/18: [Issue #32](https://github.com/wakadorimk2/vayria/issues/32) でHard Freezeする
- → 9/19〜22: [Issue #26](https://github.com/wakadorimk2/vayria/issues/26) で最終Owner Playcheckを行う

## Recently Done

- [PR #75](https://github.com/wakadorimk2/vayria/pull/75) LifeDynamicsを通常経路へ採用し、カードdrag時の視線追従を修正した
- [PR #82](https://github.com/wakadorimk2/vayria/pull/82) Aivis Cloud streamingとTTFA比較経路を追加した
- [PR #81](https://github.com/wakadorimk2/vayria/pull/81) PROJECT.mdを正本とするMission Controlローカルビューを追加した
