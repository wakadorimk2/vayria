# GitHub紹介欄の公開前レビュー

状態：2026-09-15に公開承認を受領。Bio・About・Website・Topics・固定順序は反映済み。VayriaのREADMEと掲載画像はマージ承認待ち。個人READMEは画像のmain反映後に公開する。

## 原稿

- Vayriaの紹介：[リポジトリREADME](../../README.md)
- 個人の紹介：[プロフィールREADME原稿](README.md)
- 掲載画像：[キービジュアル](../images/vayria-kv-poster.jpg)

プロフィールREADME原稿は、公開時に `wakadorimk2/wakadorimk2` のルート `README.md` として配置する。このレビュー文書は個人プロフィールへコピーしない。

## 紹介欄の変更前後

2026-09-15にGitHub APIとプロフィール画面で確認した値。

| 対象 | 変更前 | 変更後 |
| --- | --- | --- |
| Vayriaの説明文 | Vayria（ヴェイリア） | カードを選ぶ。会話が変わる。声・表情・動きで応えるAIキャラクター。 |
| VayriaのWebsite | 未設定 | https://vayria.me/ |
| VayriaのTopics | 未設定 | `ai-character`、`conversational-ai`、`vrm`、`interactive-experience` |
| 個人Bio | AI Software Engineer & Illustrator | AI開発とイラスト制作。会話とカード交換で応えるAIキャラクター『Vayria』を制作中。AI Software Engineer & Illustrator |
| 個人プロフィールREADME | プロフィール画面に表示なし。同名リポジトリの取得は404 | [プロフィールREADME原稿](README.md)を掲載 |

個人のWebsite欄は、既存の `wakadori.me` を維持する。

## 固定リポジトリの順序

Vayriaはすでに固定されている。先頭へ移動し、6件すべてを維持する。

| 順位 | 変更前 | 変更後 |
| --- | --- | --- |
| 1 | wakadori.me | vayria |
| 2 | vayria | wakadori.me |
| 3 | modscope | modscope |
| 4 | codex-hud | codex-hud |
| 5 | enterlight | enterlight |
| 6 | ae2-dashboard | ae2-dashboard |

## 画像とクレジット

- 指定された `Vayria.png` から、全体の構図を保って縮小した。
- 掲載画像はJPEG形式。幅1,200px、高さ1,694px、588,687バイト。
- READMEの表示幅は420px。個人プロフィールの表示幅は280px。
- クレジットは「立ち絵：wakadori／キービジュアルデザイン：共同制作」で統一する。
- 個人READMEはVayriaリポジトリの `main/docs/images/vayria-kv-poster.jpg` を参照する。画像をmainへ反映する前に、個人READMEを公開しない。

## 公開時の手順

1. この差分と紹介欄の変更内容について、ユーザーの内容確認を得る。
2. Vayriaの最新READMEとGitHub紹介欄を再確認する。確認後の変更がある場合は保持して差分を調整する。
3. VayriaのREADME、開発ガイド、掲載画像をレビュー対象として提出する。マージは「マージOK!」を受け取ってから行う。
4. 掲載画像がmainから取得できることを確認する。
5. `wakadorimk2/wakadorimk2` の有無を再確認する。存在しない場合は公開リポジトリを作成する。存在する場合は現在のREADMEを読み、無条件に上書きしない。
6. 個人READMEを配置し、承認されたBio・About・Topics・固定順序を反映する。
7. GitHub上でPC幅とスマートフォン幅のREADMEと個人プロフィールを確認する。画像、クレジット、リンク、固定順序を再確認する。

## 検証の範囲

- `git diff --check` は成功した。原稿とレビュー文書の相対リンク8件は存在を確認した。
- 両READMEはGitHub Markdown APIでHTMLへ変換できた。GitHubが追加する画像の `max-width: 100%` も確認した。
- 変換結果にローカルの表示スタイルと掲載画像を組み合わせ、幅1,280pxと390pxで確認した。画像は読み込まれ、横方向のはみ出しはなかった。
- 上記プレビューはGitHubの公開画面そのものではない。個人READMEの公開画像URLは、Vayriaのmainへの画像反映後に確認する。
- GitHubの最新READMEは、編集前のローカルREADMEと同じ内容だった。
- 公式サイトにアプリ画面と会話の操作が表示された。会話や有料生成の成功は未検証。
- ポートフォリオの表示と、Vayria・AI開発・イラスト制作の紹介を確認した。
- アプリの機能、API、型、実行設定は変更していない。
- 公開後のGitHub画面の確認は、公開反映後に実施する。
