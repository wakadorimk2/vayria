# Vayria Mission Control

- Target: 2026-09-23 Exhibition
- Reviewed: 2026-09-12
- Phase: 3/5 Selection

## Phases

- 成立
- Experience Push
- Selection
- Polish & Freeze
- Exhibition

## Now

- ✅ 9/12 Owner方針: Speed・Conversation・Card・Embodiment・Exhibition UIの既存5候補は残す。採用方針と実機検証の完了を分ける
- 🎨 生成系を展示に採用する方針。カードによる変化の伝わり方、生成待ち、失敗時の継続、費用を重点に仕上げる
- 🔊 GPT-Liveは見送り方向。Owner評価は「応答は自然だが、声がヴェイリアの印象に合わない」。展示音声は従来方式を軸にする
- 📱 展示体験はiPad 1台。タップは作業用機器とスマホの給電にも使う。展示専用PCの常時稼働を前提にしない。給電する機器の同時合計100W以内を確認する
- 📡 会場Wi-Fiを使う。外部HTTPS・認証・再接続は未確認。回線問い合わせは未送信。Live用WebRTCの確認は再採用を検討する場合に行う
- 📋 版・設定・実機結果はdocs/exhibition-readiness.mdへ記録する。Ownerの採用方針を、自動検証や実機試験の合格に置き換えない

## Next

- → 生成系: 採用対象の配信版と生成設定をそろえる。カード変更から生成結果までの見せ方を確認する。待機・失敗・参加者交代でも体験を継続できるよう整える
- → iPad: 従来の声と生成系を組み合わせ、一往復・交代・録音と再生の停止・通信失敗後の復帰を確認する。初見評価とOwner評価を分けて記録する
- → 給電と回線: iPad・作業用機器・スマホの同時給電を確認する。会場回線の条件を確認する。電力の実測値と会場での成功は未確認
- → [Smoke Test #29](https://github.com/wakadorimk2/vayria/issues/29) の残る実機検証と [Selection #30](https://github.com/wakadorimk2/vayria/issues/30) の記録を整える。既存5候補を残す方針は決まった。GitHubへの反映と課題完了は別途扱う
- → 9/13〜17: [Issue #31](https://github.com/wakadorimk2/vayria/issues/31) で採用する体験を磨き、Go/No-Goを確認する
- → 9/17まで: [Issue #27](https://github.com/wakadorimk2/vayria/issues/27) と [Issue #28](https://github.com/wakadorimk2/vayria/issues/28) の運用・搬入準備を整える。90×90cm、A1ポスター、クロスを維持する
- → 9/18: [Issue #32](https://github.com/wakadorimk2/vayria/issues/32) でHard Freezeする。以降の変更はbug・recovery・performance・runbookに限定する
- → 9/19〜22: [Issue #26](https://github.com/wakadorimk2/vayria/issues/26) で最終Owner Playcheckと搬入確認を行う

## Recently Done

- 9/12 選定方針を更新。既存5候補を維持し、生成系を採用する。GPT-Liveは声の印象を理由に見送り方向。実機・電力・回線の未確認事項を別管理にした

- 9/9 展示モードをローカル実装。型検査・lint・通常/公開ビルド・既存テスト・公開版49件を確認した。iPad相当サイズの模擬ブラウザー試験も成功した。展示モードの配信・本番枠作成・有料生成・実機確認は未実施。

- [PR #86](https://github.com/wakadorimk2/vayria/pull/86) LLM provider単位のレイテンシ計測を追加した
- [PR #85](https://github.com/wakadorimk2/vayria/pull/85) viewer activityへ適応する自律発話タイミング候補を追加した
- [PR #84](https://github.com/wakadorimk2/vayria/pull/84) card drop時の視線、非言語反応、返答をつなぐ候補を追加した
- [PR #75](https://github.com/wakadorimk2/vayria/pull/75) LifeDynamicsを通常経路へ採用し、カードdrag時の視線追従を修正した
- [PR #82](https://github.com/wakadorimk2/vayria/pull/82) Aivis Cloud streamingとTTFA比較経路を追加した
- [PR #81](https://github.com/wakadorimk2/vayria/pull/81) PROJECT.mdを正本とするMission Controlローカルビューを追加した
