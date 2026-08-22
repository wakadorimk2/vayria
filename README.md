# Vayria

Vayria（ヴェイリア）は、VRM キャラクターと一往復会話するための最小ローカル AI Performer アプリです。

テキストを送信すると、OpenAI が短い返答と感情を生成します。返答は音声で再生され、
実際の再生音量に合わせて VRM の `aa` 表情が動きます。返答の感情に合わせて、
VRM の表情と zonoko の音声スタイルも切り替わります。

Performer Runtimeは、カードなしでも動作するAITuberのbaselineを提供します。
WildCardは、演者へ一時的または背景的な効果を加えるLive Directionです。

画面には、キャラクターの脳内カード5枚とプレイヤーの手札5枚があります。
手札と脳内のカードを1枚ずつ交換すると、交換したカードが次の返答へ必ず影響します。
返答後は、実際に作用した脳内カードが浮いて発光します。テキスト返答を取得すると、
スタミナが1へ戻ります。

カード作用はローカルの定義からserverが取得します。ブラウザーはカードIDとDirectionの結果を送ります。
LLMが返す`activatedCards`は、現在の脳内カードだけに制限します。交換したカードを
欠落した場合は1回だけ再生成します。

## 自律発話

アバターの準備と音声が有効な状態では、自律発話ループが動きます。初回は4秒後に発話を試み、
その後は8〜18秒を基準に、Performer Profileのinitiativeで次の発話候補の間隔を調整します。

自律発話の候補は、LLMが次の3つから1つを選びます。

- `continue`: 現在の話題を続けます。
- `new_topic`: 新しい話題へ移ります。
- `silence`: 本文と音声を生成せず、次の候補を待ちます。

`topic`と`topicTurns`はブラウザー内の一時状態です。ページを閉じると破棄します。
手札から交換したカードがある場合、`silence`は受理せず、カードが反映される発話を再生成します。
交換直後の自律発話では、交換カードを強く反映します。通常の自律発話では、
脳内カードは弱い内部状態として扱い、`activatedCards`が空のまま発話する場合があります。
直前の自律発話と同じ目立つ表現、比喩、文型、テンションは自然に避けます。

発話、沈黙、非発話反応が完了すると、次の自律発話を予約します。
通信失敗が発生すると、自律発話ループを停止します。
手動入力またはSession Resetでループを再開できます。
ミュートとタブ非表示はループだけを一時停止し、会話の履歴、話題、演者状態、カード状態を保持します。

Sessionはページ内だけの一時状態です。
履歴、話題、直前の自律返答、演者状態、カードのターン状態を含みます。
localモードの開発画面には`Session Reset`を表示します。
Session Resetは実行中の処理を停止し、Sessionを初期状態へ戻します。
既存の`Reset Turn`はカードのターン状態だけを戻します。
音量設定と読み込み済みアバターはSession Resetでも保持します。

## 必要なもの

- Node.js 24（現在の検証環境）
- npm
- OpenAI API key
- AivisSpeech と利用する音声合成モデル
- 自分で利用権を持つ VRM ファイル
- Chrome、Chromium 系ブラウザー、または iPad の Safari

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

4. API keyをリポジトリ外の秘密ファイルへ保存します。

   既定のパスは`C:\Users\wakad\.vayria\secrets.env`です。
   別のWindowsユーザーでは、自分のユーザープロファイル配下に作成します。

   ```dotenv
   OPENAI_API_KEY=your_key_here
   ```

   このファイルはGitリポジトリの外へ置きます。

5. `.env.local`には秘密ファイルのパスとAivisSpeechの設定を記述します。

   ```dotenv
   OPENAI_API_KEY=
   VAYRIA_SECRET_FILE=C:\Users\<Windowsユーザー名>\.vayria\secrets.env
   AIVIS_BASE_URL=http://127.0.0.1:10101
   AIVIS_SPEED_SCALE=1.15
   AIVIS_PITCH_SCALE=0
   AIVIS_INTONATION_SCALE=1.0
   AIVIS_TEMPO_DYNAMICS_SCALE=1.0
   ```

   `VAYRIA_SECRET_FILE`を設定した場合、外部ファイルの`OPENAI_API_KEY`を優先します。
   `VAYRIA_SECRET_FILE`を設定しない場合は、既存の`.env.local`直書き方式を使用します。

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

6. worktreeごとに`.env.local`を作成して、APIを起動します。

   Codexデスクトップアプリでは、新規チャットで`Worktree`と`Local environment`を選択すると、
   セットアップスクリプトがworktree作成時に実行されます。
   これはCodexアプリ自体の起動時処理ではありません。

   Local environmentのSetup scriptには、次の2行を登録します。

   ```powershell
   npm ci
   pwsh -NoProfile -File .\scripts\Setup-VayriaWorktree.ps1
   ```

   Local environmentのActionには、次を登録します。

   ```powershell
   npm run dev
   ```

   Setup scriptはAPIを起動しません。
   ActionがworktreeごとのAPIを起動します。
   `main`は`5187`を使用します。
   worker worktreeは`5188`から`5210`の空きポートを自動で使用します。
   Setup scriptはworktreeごとの`.env.exhibition.local`も自動で生成します。
   `.env.exhibition.example`を毎回コピーする必要はありません。
   既存の`.env.local`は上書きしません。
   `.env.local`には実キーを保存しません。

   CodexアプリのSettingsでLocal environmentを作成し、アプリが生成したプロジェクト`.codex`設定を確認します。
   設定スキーマは手書きしません。
   `.codex`設定には認証情報やAPIキーを含めません。
   `.worktreeinclude`には`.env.local`を追加しません。

   Codexを使わない場合は、次のラッパーでAPI keyをコピーせずにworktreeの設定を作成できます。
   その後、対象worktreeで`npm run dev`を起動します。

   ```powershell
   pwsh -NoProfile -File .\scripts\Start-VayriaWorktree.ps1 `
     -WorktreePath 'C:\path\to\worktree' `
     -Port 5188
   ```

   設定だけを作成する場合は、次のスクリプトを使用します。

   ```powershell
   pwsh -NoProfile -File .\scripts\Initialize-WorktreeEnv.ps1 `
     -WorktreePath 'C:\path\to\worktree' `
     -Port 5188
   ```

   既存の`.env.local`は、`-Force`を指定しない限り上書きしません。

   `main`は`5187`を使用します。
   各worker worktreeは`5188`から`5210`の未使用ポートを使用します。

7. VRMの正本をGitリポジトリの外へ保存します。

   既定の正本パスは次です。

   ```text
   %USERPROFILE%\.vayria\avatar\model.vrm
   ```

   現在のmain worktreeにあるVRMを初回の正本へ移行する場合は、次を実行します。
   この操作はmain worktreeの元ファイルを削除しません。

   ```powershell
   New-Item -ItemType Directory -Path "$env:USERPROFILE\.vayria\avatar" -Force
   Copy-Item -LiteralPath 'C:\Users\wakad\projects\vayria\public\avatar\model.vrm' `
     -Destination "$env:USERPROFILE\.vayria\avatar\model.vrm"
   ```

   Codexのworktreeセットアップは、正本がある場合に、VRMがないworktreeへコピーします。
   既存のVRMは自動で上書きしません。

   現在のworktreeだけを明示的に同期する場合は、次を実行します。

   ```powershell
   pwsh -NoProfile -File .\scripts\Sync-VayriaAvatar.ps1
   ```

   全worktreeを明示的に同期する場合は、対象を確認してから`-Force`を指定します。

   ```powershell
   pwsh -NoProfile -File .\scripts\Sync-VayriaAvatar.ps1 `
     -AllWorktrees -Force
   ```

   各worktreeの実行用コピーは次のパスです。

   ```text
   public/avatar/model.vrm
   ```

8. 開発サーバーを起動します。

   ```powershell
   npm run dev
   ```

9. `http://127.0.0.1:5187/` をブラウザーで開きます。

## モーションライブラリ

保存済み VRMA は `public/avatar/motions/manifest.json` で管理します。

manifest の `assetId`、SHA-256、duration、tag、補正 profile ID が、再生 asset の契約です。

現在の manifest は空です。

curated VRMA は、構造検証と実際の Vayria VRM での owner Playcheck 後に登録します。

ARDY の source、Python 環境、checkpoint、LLM cache、生成途中ファイルは、`%USERPROFILE%\.vayria\ardy\` の外部環境へ置きます。

生成手順は [`tools/motion/README.md`](tools/motion/README.md) を参照してください。

ブラウザーは ARDY process へ接続しません。

展示は保存済み motion のみで成立します。

## 運用モード

アプリは同じフロントエンドと API パスを、次のモードで使用します。

| モード | 用途 | 初期接続先 |
| --- | --- | --- |
| `local` | Windows PC 内の開発 | `127.0.0.1:5187` |
| `exhibition` | Windows PC と iPad の同一 LAN 接続 | `0.0.0.0:5187` 待受け |
| `public` | 将来の HTTPS 公開 | 今回は公開サーバーを提供しません |

### 展示コピー

展示画面と会場パネルで使用する正本コピーです。

メインコピー：

> Vayriaに一枚、どうぞ。

補助コピー：

> 気になるカードを一枚、Vayriaの脳内へ。

### iPad 展示の確認

1. `.env.example` を `.env.local` へコピーし、API key と AivisSpeech の設定を記述します。
2. worktreeのSetup scriptが`.env.exhibition.local`を生成したことを確認します。
   `.env.exhibition.example`の手動コピーは不要です。
3. AivisSpeech を Windows PC で起動します。
4. exhibition モードで Vite を起動します。

   ```powershell
   npm run dev:exhibition
   ```

5. Vite が表示する `Network` URL を iPad で開きます。

   ```text
   http://<Windows PC の LAN アドレス>:<worktreeに割り当てられたポート>/
   ```

iPad と Windows PC は同一 LAN に接続してください。Wi-Fi と Ethernet のどちらも使用できます。
LAN アドレスはソースへ記述しません。起動時に表示された URL を使用します。
`main` worktreeは`5187`、worker worktreeは`5188`から`5210`の割り当てポートを使用します。

Windows ファイアウォールは、プライベートネットワーク上の Node.js または Vite に対して TCP `5187`から`5210`の受信を一度だけ許可してください。
インターネットへポート転送は設定しないでください。

`VITE_API_BASE_URL=/` は現在のページと同じ接続先を使用します。別の HTTPS API を使用する場合だけ、`VITE_API_BASE_URL` を変更します。

`public` モードは将来の公開用設定名です。公開 URL、公開中継、認証、永続セッション管理は今回の対象外です。
`getUserMedia()` とカメラ背景も今回の対象外です。カメラを追加する場合は HTTPS または同等の Secure Context が必要です。

`.env.local`、`public/avatar/*.vrm`、生成途中の motion asset は Git の追跡対象外です。
`.env.exhibition` と `.env.exhibition.local` も Git の追跡対象外です。
VRMの正本もGitリポジトリの外に置きます。`.worktreeinclude`には追加しません。
API key と AivisSpeech の設定は Vite の Node middleware だけが読みます。
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

想定外の emotion は `neutral` へ戻します。Performer Runtimeはemotionをturn開始時に
neutralへresetしません。activationは設定したhalf-lifeでbaselineへ減衰します。
カードやPerformance Planは、発話前reaction、視線、音声速度、抑揚、idle motionを変更できます。

## 検証

```powershell
npm run test
npm run lint
npm run typecheck
npm run build
```

## 展示向け同時操作ストレステスト

開発サーバーとAivisSpeechを起動した状態で、仮想5ユーザーの短時間バーストを実行できます。
既定では、各ユーザーが4ターンを150ms間隔で送信します。

```powershell
npm run stress -- --users 5 --rounds 4 --gap-ms 150
```

CLIは`/api/chat`と`/api/tts`へ同時にリクエストを送ります。
固定seedは`exhibition-burst-v1`です。
同じseedを指定すると、同じ入力列を再現できます。

OpenAIとAivisSpeechを実際に呼び出すため、実行回数と利用料に注意してください。
CLIは自動リトライを行いません。
結果は`stress-results/`へ保存します。

Chat、TTS、全体ターンのp95を任意の閾値で判定できます。

```powershell
npm run stress -- `
  --max-p95-chat-ms 8000 `
  --max-p95-tts-ms 8000 `
  --max-p95-turn-ms 20000
```

## 自然さPlaycheck

固定6ケースと5軸rubricで、AITuberの自然さをOwnerが確認できます。
評価専用UIは追加しません。PCの対話CLIが採点を受け付けます。

PCだけで確認する場合は、Viteを起動します。

端末1:

```powershell
npm run dev
```

端末2:

```powershell
npm run playcheck -- start --base-url http://127.0.0.1:5187/
```

展示モードでiPadを使う場合は、Viteの`Network` URLを使用します。

```powershell
npm run dev:exhibition
```

別の端末で次を実行します。

```powershell
npm run playcheck -- start --base-url http://<PCのLANアドレス>:5187/
```

CLIが生成したQRページがPCの既定ブラウザーで開きます。
iPadのカメラでQRコードを読み取ります。
iPadとWindows PCは同じLANに接続してください。
QRページを自動で開かない場合は、次を使います。

```powershell
npm run playcheck -- start --base-url http://<PCのLANアドレス>:5187/ --no-open-qr
```

その場合は、CLIに表示された`QR page`のパスをPCのブラウザーで開きます。
CLIは従来の`playcheckRunId`付きURLも表示します。
同じrun IDを指定して、PCで対話式採点を開始します。

```powershell
npm run playcheck -- score --run-id <runId>
```

CLIは6ケースの前提、操作、観察点を表示します。
iPadでケースを実行し、PCへ戻ってEnterを押します。
CLIが自然さに関する5つの質問と短い所感を尋ねます。
入力はケースごとに保存されます。
途中で終了した場合は、同じ`score`コマンドで再開できます。
特定ケースを再採点する場合は`--case <scenarioId>`を追加します。

採点完了後に、匿名集計を生成します。

```powershell
npm run playcheck -- finalize --run-id <runId>
```

生イベントとCLIの作業状態は`playcheck-results/local/`へ保存します。
作業状態のJSONはCLIが管理します。Ownerは直接編集しません。
所感は匿名のrun結果へ保存します。
発話本文、履歴、API key、個人情報は所感へ書きません。
Gitには`docs/evaluation/results/`の匿名集計だけを保存します。

ブラウザーは開発時に、次の会話イベントを構造化ログへ出力します。

`input_received`、`llm_start`、`llm_done`、`tts_start`、`tts_ready`、
`animation_start`、`turn_completed`、`turn_aborted`、`turn_failed`

ログはブラウザーのコンソールとViteのターミナルへ出力します。
入力本文、返答本文、履歴、API keyはイベントログへ含めません。
`animation_start`は音声再生とリップシンク開始時点です。

各provider requestは`X-Performer-Turn-Id`で会話イベントと関連付けます。
serverは既存clientの`X-Wildcard-Turn-Id`も互換目的で受理します。
`/api/events`は開発時の構造化イベントを受け取り、providerの同時実行数も記録します。

## 現時点で実装しないもの

- 会話履歴と長期記憶
- 配信、認証、DB
- provider とキャラクターの選択 UI
- カードのweight、TTL、コスト、自動ランダム交換
- コメント取得、fake audience、配信サービス連携
- TTSキュー、発話分割、ストリーミング、割り込み再開
- 話題の永続記憶
- ARDY runtime generation、自由な motion selector、複雑な VRMA blending
- 長期的な mood、感情履歴
- production server と deployment

`npm run dev` のローカル利用と、`npm run dev:exhibition` の同一 LAN 展示確認を対象にしています。
production server、公開 URL、公開中継は対象外です。
