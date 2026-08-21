# Wildcard

VRM キャラクターと一往復会話するための最小ローカルアプリです。

テキストを送信すると、OpenAI が短い返答と感情を生成します。返答は音声で再生され、
実際の再生音量に合わせて VRM の `aa` 表情が動きます。返答の感情に合わせて、
VRM の表情と zonoko の音声スタイルも切り替わります。

画面には、キャラクターの脳内カード5枚とプレイヤーの手札5枚があります。
手札と脳内のカードを1枚ずつ交換すると、交換したカードが次の返答へ必ず影響します。
返答後は、実際に作用した脳内カードが浮いて発光します。テキスト返答を取得すると、
スタミナが1へ戻ります。

カード作用はローカルの定義からserverが取得します。ブラウザーはカードIDだけを送ります。
LLMが返す`activatedCards`は、現在の脳内カードだけに制限します。交換したカードを
欠落した場合は1回だけ再生成します。

## 自律発話

アバターの準備と音声が有効な状態では、自律発話ループが動きます。初回は4秒後に発話を試み、
その後は8〜18秒の間隔で次の発話候補を作ります。

自律発話の候補は、LLMが次の3つから1つを選びます。

- `continue`: 現在の話題を続けます。
- `new_topic`: 新しい話題へ移ります。
- `silence`: 本文と音声を生成せず、次の候補を待ちます。

`topic`と`topicTurns`はブラウザー内の一時状態です。ページを閉じると破棄します。
手札から交換したカードがある場合、`silence`は受理せず、カードが反映される発話を再生成します。

## 必要なもの

- Node.js 24（現在の検証環境）
- npm
- OpenAI API key
- AivisSpeech と利用する音声合成モデル
- 自分で利用権を持つ VRM ファイル
- Chrome または Chromium 系ブラウザー

## セットアップ

1. 依存関係をインストールします。

   ```powershell
   npm install
   ```

2. `.env.example` を `.env.local` へコピーします。

   ```powershell
   Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
   ```

3. zonoko モデルを追加した AivisSpeech を起動します。

   アプリは `http://127.0.0.1:10101/speakers` から zonoko のスタイル名と
   ID を取得します。API の詳細は
   `http://127.0.0.1:10101/docs` でも確認できます。

4. `.env.local` に API key と AivisSpeech の設定を記述します。

   ```dotenv
   OPENAI_API_KEY=your_key_here
   AIVIS_BASE_URL=http://127.0.0.1:10101
   AIVIS_SPEED_SCALE=1.15
   AIVIS_PITCH_SCALE=0
   AIVIS_INTONATION_SCALE=1.0
   AIVIS_TEMPO_DYNAMICS_SCALE=1.0
   ```

   アプリは emotion に対応する zonoko style ID を `/speakers` から取得します。
   音声パラメーターは省略できます。省略時は上記の値を使います。

   | 環境変数 | AivisSpeech の項目 | 許容範囲 |
   | --- | --- | --- |
   | `AIVIS_SPEED_SCALE` | 話速 (`speedScale`) | `0.5` ～ `2.0` |
   | `AIVIS_PITCH_SCALE` | 音高 (`pitchScale`) | `-0.15` ～ `0.15` |
   | `AIVIS_INTONATION_SCALE` | 感情表現の強弱 (`intonationScale`) | `0.0` ～ `2.0` |
   | `AIVIS_TEMPO_DYNAMICS_SCALE` | テンポの緩急 (`tempoDynamicsScale`) | `0.0` ～ `2.0` |

   zonoko の一部スタイルでは、AivisSpeech が
   `AIVIS_INTONATION_SCALE` を無視する場合があります。
5. 自作または利用許可を持つ VRM を次の場所へ置きます。

   ```text
   public/avatar/model.vrm
   ```

6. 開発サーバーを起動します。

   ```powershell
   npm run dev
   ```

7. `http://127.0.0.1:5187/` をブラウザーで開きます。

`.env.local` と `public/avatar/*.vrm` は Git の追跡対象外です。
API key と AivisSpeech の設定は Vite のローカル Node middleware だけが読みます。
ブラウザー bundle には埋め込みません。

## 感情マッピング

| emotion | VRM expression | zonoko style |
| --- | --- | --- |
| `neutral` | `neutral` | `ノーマル` |
| `fun` | `relaxed` | `B` |
| `joy` | `happy` | `C` |
| `sorrow` | `sad` | `A` |
| `angry` | `angry` | `D` |
| `surprised` | `surprised` | `ノーマル` |

想定外の emotion は `neutral` へ戻します。音声再生が終わると、800ms 後に
VRM 表情も `neutral` へ戻ります。音声の速度、ピッチ、抑揚、テンポは全感情で共通です。

## 検証

```powershell
npm run lint
npm run typecheck
npm run build
```

## 現時点で実装しないもの

- 会話履歴と長期記憶
- 配信、認証、DB
- provider とキャラクターの選択 UI
- カードのweight、TTL、コスト、自動ランダム交換
- コメント取得、fake audience、配信サービス連携
- TTSキュー、発話分割、ストリーミング、割り込み再開
- 話題の永続記憶、発話イベントログ
- VRMA、長期的な mood、感情履歴、モーション選択
- production server と deployment

`npm run dev` のローカル利用だけを対象にしています。
