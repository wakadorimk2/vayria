# Wildcard

VRM キャラクターと一往復会話するための最小ローカルアプリです。

テキストを送信すると、OpenAI が短い返答を生成します。返答は音声で再生され、
実際の再生音量に合わせて VRM の `aa` 表情が動きます。

## 必要なもの

- Node.js 24（現在の検証環境）
- npm
- OpenAI API key
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

3. `.env.local` に API key を設定します。

   ```dotenv
   OPENAI_API_KEY=your_key_here
   ```

4. 自作または利用許可を持つ VRM を次の場所へ置きます。

   ```text
   public/avatar/model.vrm
   ```

5. 開発サーバーを起動します。

   ```powershell
   npm run dev
   ```

6. `http://127.0.0.1:5187/` をブラウザーで開きます。

`.env.local` と `public/avatar/*.vrm` は Git の追跡対象外です。
API key は Vite のローカル Node middleware だけが読みます。ブラウザー bundle
には埋め込みません。

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
