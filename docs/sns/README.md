# 展示前SNS公開計画 — 素材台帳

期限: 2026-09-17 21:00。計画の正本はNotion「Vayria 展示前SNS公開計画」とGoogleカレンダー。
この文書はリポジトリ内の素材の所在と状態を記録する。Notion側のチェック項目と内容に差異がある場合はNotionを優先し、こちらを更新する。

## チェック項目の対応

| 項目 | 素材 | 状態 |
| --- | --- | --- |
| 投稿用KV | [kv/](kv/) 配下の展開3種 + 元素材 `docs/images/` | ✅ 3種生成済み・目視確認済み（2026-09-16） |
| 投稿文案5本 | [posts.md](posts.md) | ✅ 下書き5本・作者一人称トーンに調整済み。公開前にユーザー確認 |
| 15〜25秒の字幕付き実演動画 | [video-storyboard.md](video-storyboard.md)・[assets/](assets/) | ✅ 24.3秒・縦長1080×1920マスター2版（Shorts/X）。**mp4はNotionで配布**（git管理外・`.gitignore`済み） |

## 確定事実（文案・字幕に使用可）

- 展示: 2026-09-23、浜松町館5F（GENAI EXPO系イベント）。ブース90×90cm。
- 公式サイト: https://vayria.me/
- キャッチコピー: 「カードを選ぶ。会話が変わる。」
- クレジット: 「立ち絵：wakadori／キービジュアルデザイン：共同制作」

未検証の性能・品質表現（速度・精度の数値）は文案に使わない。

## 素材一覧

| ファイル | 用途 | 出典 |
| --- | --- | --- |
| `kv/vayria-kv-x.jpg` | X投稿用（縦長 1080×1920） | `docs/images/vayria-kv-poster.jpg` から生成 |
| `kv/vayria-kv-note.jpg` | noteアイキャッチ用 1280×670 | 同上 |
| `kv/vayria-kv-shorts.jpg` | Shorts/TikTokカバー・動画エンドカード用 1080×1920 | 同上 |
| `posts.md` | 投稿文案5本（X×3、Shorts/TikTok、note） | 作成済み文案 |
| `video-storyboard.md` | 実演動画の台本 | 収録・編集手順の正本 |
| `assets/captions.ass` | スタイル付き焼き付け字幕の正本（フェード・ポップイン・BIZ UDPGothic） | 台本に対応 |
| `assets/captions.srt` | 字幕の派生（srt形式・同タイミング） | captions.ass から派生 |
| `assets/vayria-demo-*.mp4` | 完成動画（shorts/x は同一縦長マスター）。**Notionで配布・git管理外** | 収録後に生成 |

## 公開前の確認

- [ ] 文案の日付・URL・会場名を本READMEの確定事実と照合
- [ ] 動画に秘密情報・管理画面・個人情報が映っていない
- [ ] 動画の尺が15〜25秒、字幕が全編で読める
- [ ] mp4等の大きい素材のコミット可否をユーザーと確認
- [ ] 投稿・公開操作はユーザーの明示指示のみ実施
