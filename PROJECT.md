# Vayria Mission Control

- Target: 2026-09-23 Exhibition
- Reviewed: 2026-09-10
- Phase: 3/5 Selection

## Phases

- 成立
- Experience Push
- Selection
- Polish & Freeze
- Exhibition

## Now

- 📍 9/10確認: 公式会場は浜松町館5F。5候補の版・切替・実機証拠はdocs/exhibition-selection-20260910.mdで照合する。合計電力と会場HTTPS条件は未確認
- 🖥 [Exhibition UI #89](https://github.com/wakadorimk2/vayria/issues/89) — 初見の利用者が働きかけ方、現在の状態、次の操作を理解できる情報階層と導線を作る

- 🚧 展示準備: 公開版の起動・復旧手順をdocs/exhibition-quickstart.mdへ整理した。9/10までの合計電力と会場回線の確認はdocs/exhibition-power-network-check.md。5候補の比較と期限はdocs/exhibition-readiness.md。実測・実機・Owner評価は未確認

- 公開版と同じURL・ビルドに展示モードを追加する。端末登録、参加者交代、展示枠全体の推計API予算10,000円を使う。手順: docs/public-exhibition.md

- 🔥 [Experience Push Tracker #80](https://github.com/wakadorimk2/vayria/issues/80) — 5候補のうちSpeed、Conversation、Cardを実装済み。残るEmbodimentとExhibition UIをSelectionへ渡せる状態にする
- ⚡ Speed — [LLM #83](https://github.com/wakadorimk2/vayria/issues/83)は現状十分として完了。[TTS #78](https://github.com/wakadorimk2/vayria/issues/78)で展示用PC、本番予定network、failure recoveryを確認する
- 💬 Conversation — [Issue #23](https://github.com/wakadorimk2/vayria/issues/23)の実機・復帰条件を確認し、[Issue #87](https://github.com/wakadorimk2/vayria/issues/87)でセッション内記憶が会話の自然さへ与える効果を検証する
- 👀 [Embodiment #79](https://github.com/wakadorimk2/vayria/issues/79) — 発話開始時の視線、表情、モーションを一つの身体反応として尖らせる
- 🛡 [Guardrails #21](https://github.com/wakadorimk2/vayria/issues/21)・[#24](https://github.com/wakadorimk2/vayria/issues/24)・[#25](https://github.com/wakadorimk2/vayria/issues/25) — 実環境再現性、表情・音声競合、性能・復帰・安全なログの下限を維持する

## Next

- → 検証URLを https://vayria.me/staging/ へ移す変更を実装。旧サブドメインは転送する。移行手順: docs/staging-url-migration.md。配信版・台帳を記録し、検証Turnstileへvayria.meを追加済み。9/10に#107のマージを確認。現在の配信Versionと稼働は別途確認する。記録: docs/staging-url-preflight-2026-09-09.md。

- → 公開版の参加導線: 挨拶ボタン、ガラスパネルのカード開閉、独立した接続案内をローカル実装した。関連テスト371件と展示・公開ビルドが成功。docs/evaluation/public-greeting-entry.md に沿って実AI・iOS・初見利用者を確認する。未公開
- → 9/9同期完了: この作業へorigin/mainのc0c26fbを取り込んだ。参加導線と停止後通知修正を保持し、公開セッション確認・マイク表示との競合を解消した。関連テスト368件と展示・公開ビルドが成功。改善自体は未コミット・未公開。docs/evaluation/exhibition-participation-research.md の統合記録を参照する
- → Selectionの参加導線: 一操作での初回交換、18枚の変化予告と話題、同じ質問での比較、返答の振り返り、交代リセットを候補実装した。停止後の音声通知を無視する修正を回帰テストで確認した。docs/evaluation/exhibition-participation-research.md に沿って実AI・実音声と参加率を確認する。模擬応答でのブラウザー操作は確認済み、参加率の改善は未検証
- → 9/8〜12: [Issue #29](https://github.com/wakadorimk2/vayria/issues/29) で5候補をSmoke Testし、[Issue #30](https://github.com/wakadorimk2/vayria/issues/30) で候補ごとにKeep/Dropを決める。採用数に上限は設けない
- → 9/13〜17: [Issue #31](https://github.com/wakadorimk2/vayria/issues/31) でKeepした体験を磨き、Go/No-Goを確定する
- → 9/17まで: [Issue #27](https://github.com/wakadorimk2/vayria/issues/27) と [Issue #28](https://github.com/wakadorimk2/vayria/issues/28) へ運用手順と搬入準備を反映する
- → 9/18: [Issue #32](https://github.com/wakadorimk2/vayria/issues/32) でHard Freezeする
- → 9/19〜22: [Issue #26](https://github.com/wakadorimk2/vayria/issues/26) で最終Owner Playcheckを行う

## Recently Done

- 9/9 展示モードをローカル実装。型検査・lint・通常/公開ビルド・既存テスト・公開版49件を確認した。iPad相当サイズの模擬ブラウザー試験も成功した。展示モードの配信・本番枠作成・有料生成・実機確認は未実施。

- [PR #86](https://github.com/wakadorimk2/vayria/pull/86) LLM provider単位のレイテンシ計測を追加した
- [PR #85](https://github.com/wakadorimk2/vayria/pull/85) viewer activityへ適応する自律発話タイミング候補を追加した
- [PR #84](https://github.com/wakadorimk2/vayria/pull/84) card drop時の視線、非言語反応、返答をつなぐ候補を追加した
- [PR #75](https://github.com/wakadorimk2/vayria/pull/75) LifeDynamicsを通常経路へ採用し、カードdrag時の視線追従を修正した
- [PR #82](https://github.com/wakadorimk2/vayria/pull/82) Aivis Cloud streamingとTTFA比較経路を追加した
- [PR #81](https://github.com/wakadorimk2/vayria/pull/81) PROJECT.mdを正本とするMission Controlローカルビューを追加した
