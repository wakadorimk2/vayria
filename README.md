# Wildcard

VRM キャラクターと一往復会話するための最小ローカルアプリです。

テキストを送信すると、OpenAI が短い返答を生成します。返答は音声で再生され、
実際の再生音量に合わせて VRM の `aa` 表情が動きます。

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

3. AivisSpeech を起動します。

   `http://127.0.0.1:10101/speakers` を開き、利用する話者スタイルの
   `styles[].id` を確認します。API の詳細は
   `http://127.0.0.1:10101/docs` でも確認できます。

4. `.env.local` に API key と AivisSpeech の設定を記述します。

   ```dotenv
   OPENAI_API_KEY=your_key_here
   AIVIS_BASE_URL=http://127.0.0.1:10101
   AIVIS_STYLE_ID=1599412416
   AIVIS_SPEED_SCALE=1.15
   AIVIS_PITCH_SCALE=0
   AIVIS_INTONATION_SCALE=1.0
   AIVIS_TEMPO_DYNAMICS_SCALE=1.0
   ```

   上記は `zonoko / ノーマル` の推奨設定です。
   `AIVIS_STYLE_ID` は、音声合成モデルとスタイルの組み合わせを指定します。
   各設定は省略できます。省略時は上記の値を使います。

   | 環境変数 | AivisSpeech の項目 | 許容範囲 |
   | --- | --- | --- |
   | `AIVIS_SPEED_SCALE` | 話速 (`speedScale`) | `0.5` ～ `2.0` |
   | `AIVIS_PITCH_SCALE` | 音高 (`pitchScale`) | `-0.15` ～ `0.15` |
   | `AIVIS_INTONATION_SCALE` | 感情表現の強弱 (`intonationScale`) | `0.0` ～ `2.0` |
   | `AIVIS_TEMPO_DYNAMICS_SCALE` | テンポの緩急 (`tempoDynamicsScale`) | `0.0` ～ `2.0` |

   `ノーマル` スタイルでは、AivisSpeech が
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

## 検証

```powershell
npm run lint
npm run typecheck
npm run build
```

## 現時点で実装しないもの

- 会話履歴と長期記憶
- 配信、コメント取得、認証、DB
- provider とキャラクターの選択 UI
- VRMA、感情制御、モーション選択
- production server と deployment

`npm run dev` のローカル利用だけを対象にしています。
