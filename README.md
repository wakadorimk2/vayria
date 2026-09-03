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

自律発話は固定タイマーで開始しません。コードは、会話入力、環境変化、活動状態変化、
内部状態変化、相互作用状態変化からEvidenceを観測します。

Evidenceが発話理由候補を作った場合だけ、状態変化スケジューラーがLLMを呼びます。
候補がない場合、経過時間や沈黙だけではLLMを呼びません。
LLMは`externalAction: speak | none`、`usedReasonIds`、`internalDelta.reasonUpdates`を返します。
`none`でも内部差分を保存できます。`speak`で使った理由だけを`resolved`に進めます。
使わなかった理由は残り、保留理由は指定した`wakeOn`だけで再評価します。

動機スタックは、最大24件のactive理由、最大8段のcausal episode、1回のdeltaあたり最大8更新で
安全停止します。これらは人格仕様ではなく、暴走防止の上限です。

`topic`、`topicTurns`、最新の視聴者意図はブラウザー内の一時状態です。ページを閉じると破棄します。
自律発話には、現在のPerformer Stateから取得したphase、energy、emotion、attentionの限定コンテキストも渡します。
このコンテキストは発話履歴やイベントログへ保存しません。
自律発話には、直前に再生完了したVayriaの発話も限定コンテキストとして渡します。手動・音声応答の直後も、直前の発話に表れた話題や関心を継続するために使用します。
この発話はセッション内だけで保持し、会話履歴とは別の重複防止用状態として扱います。
チャット要求には、現在のカード印象企画、視聴者主導の進行、カード変更前後の印象を見る目的を、限定されたProgram Contextとして渡します。
Program Contextは、セッション開始時のカード変更前と、視聴者がカードを交換した後の現在位置も保持します。
カード交換直後の自律要求には、React stateの反映を待たずに`after_card_change`を明示して渡します。
これは発話履歴へ保存せず、内部ルールやカード一覧を読み上げるためには使いません。
会話を明示的に終えた場合でも、理由がなければ発話しません。純粋な相槌や無内容発話は
自律発話理由を作りません。内容を持つ音声入力は通常の会話Evidenceとして扱います。
交換直後の自律発話では、交換カードを強く反映します。通常の自律発話では、
脳内カードは弱い内部状態として扱い、`activatedCards`が空のまま発話する場合があります。
直前の自律発話と同じ目立つ表現、比喩、文型、テンションは自然に避けます。

発話完了後に理由が残っていても、同じEvidenceは再評価しません。
マイク接続中は、視聴者のVAD発話中またはSTT処理中だけ候補処理を保留します。
Vayriaの発話中は、既存のbusy制御で新しい自律候補を開始しません。
通信失敗では、評価済みEvidenceを同じ理由で再送しません。新しいEvidenceで再評価します。
ミュートとタブ非表示は候補処理を一時停止し、理由、会話履歴、演者状態、カード状態を保持します。

## 音声入力

`local`モードでは、会話欄の`🎙 聞く`を押すとマイク入力を開始します。
利用可能な場合は、ブラウザーの`SpeechRecognition`を使用します。
`exhibition`モードでは、画面上部の`音声とマイクを有効化`を最初に押してください。
音声再生とマイク入力を同時に開始し、成功後は操作ボタンを隠します。
展示では、`AudioWorklet`で16 kHz、モノラル、PCM16へ変換し、
同一originの`/api/voice-stream`へWebSocket送信します。

ViteはPCMを解釈しません。ViteはPCMを`127.0.0.1`のPython STTサービスへ中継します。
PythonサービスはWebRTC VADとfaster-whisperを実行します。
確定した発話は、既存のLLMとTTSの経路へ渡します。

音声認識は全二重です。Vayriaが話している間も入力を受け付けます。
ユーザーの発話が確定すると、現在のLLM、TTS、音声再生を中断します。

展示モードではHTTPSとPython STTサービスが必要です。
音声入力を利用できない場合は、テキスト入力を使用してください。
スピーカー使用時はVayriaの音声を認識する可能性があります。初回確認ではヘッドセットを推奨します。
音声データは録音ファイルへ保存しません。
通常経路では音声内容をログへ出力しません。
Audio Labを有効にした開発調査では、raw transcriptを調査ログへ保存します。
会話には認識された最終文字列だけを渡します。

### Voicemeeterを使う音声入力

Voicemeeterを使う場合は、ブラウザー内で2系統をミックスしません。
VoicemeeterでマイクとChatGPT音声を混ぜ、1つの録音デバイスとしてVayriaへ送ります。

次の経路を設定します。

1. ウェブマイクをVoicemeeterの物理入力へ接続します。
2. ChatGPT音声をVoicemeeterの仮想入力へ接続します。
3. マイクとChatGPT音声の両方でB1を有効にします。
4. Vayria自身の音声ではB1を無効にします。
5. ブラウザーの入力デバイスへ、B1の録音出力を設定します。

録音デバイス名は環境により異なります。
`Voicemeeter Output`または`Voicemeeter Out B1`などの名前を選びます。
デバイス名を環境変数やコードへハードコードしません。

開発用Routerで選ぶ場合は、次のURLを使います。

```text
http://127.0.0.1:5187/?router=1&audioLab=1
```

`Remote PCM入力（Voicemeeter B1など）`でB1の録音出力を選びます。
音声入力を開始した後はデバイスを変更できません。
変更時は、いったんマイク入力を停止してください。

Vayria音声をB1へ戻すと、Vayria自身の発話をSTTが再認識する可能性があります。
自己認識ループを防ぐため、Vayria音声はB1へ送らないでください。

展示音声入力は、Python STTが`ws://127.0.0.1:8787/stream`で待ち受ける必要があります。
次のコマンドは、Windows Mobile HotspotのIPv4を実行時に検出し、検出したインターフェースだけへ展示フロントをbindしたうえで、固定パスのAivisSpeech CLI、uv経由のPython STT、npm経由の展示フロントを起動します。
OpenAI API keyは`.env.local`へ保存せず、1Passwordから起動プロセスへ注入します。

```powershell
npm run exhibition:start:op
```

このコマンドは、ユーザー領域の1Password参照ファイルを使います。
API key本体はworktreeや`.env.local`へ保存しません。
`npm run exhibition`は`npm run exhibition:start`の短縮名です。
API keyを使う場合は、`npm run exhibition:start:op`を使用します。

検証済み発話単位からTTSを開始する経路は、既定で有効です。
無効にする場合は、`VITE_STREAMING_SPEECH_ENABLED=0`、またはURLの`?streamingSpeech=0`を指定します。
この経路はvoice、manual、card changeだけに適用し、通常のautonomous発話には適用しません。
自然に分離できる4〜12文字の第一声も、既定で先行生成します。
比較時は、`VITE_EARLY_SPEECH_LEAD_ENABLED=0`、またはURLの`?earlySpeechLead=0`で無効にします。

Aivis CloudのMP3は、音質を優先して全データを受信してから再生します。
旧MediaSource経路と比較する場合は、`VITE_CLOUD_TTS_STREAM_PLAYBACK_ENABLED=1`、またはURLの`?cloudTtsStreamPlayback=1`を指定します。

マイク、ChatGPT音声、Vayria音声を個別に再生し、Vayriaの音声メーターで経路を確認します。
音声メーターはマイクとChatGPT音声で動き、Vayria自身の音声では動かない状態が期待値です。

音声入力の比較調査は、開発サーバーを起動してURLへ`?audioLab=1`を追加します。
Audio LabのMode A/B/C/D、固定ケース、JSONLログは
[`docs/evaluation/voice-audio-lab.md`](docs/evaluation/voice-audio-lab.md)を参照してください。
`?audioLab=1`を付けたAudio Labは、初期ModeにProcessedを選びます。

開発中の通常のFast Refreshでは、音声入力のセッションと`AudioContext`の破棄を短時間遅延し、更新後に同じセッションを再利用します。
音声フック自体の変更やページ全体の再読み込みでは、ブラウザーが音声セッションを再初期化するため、音声の再有効化が必要です。
通常の`exhibition`起動も、Mode BのProcessedを使います。
通常の`local`と`public`起動は、Baselineを使います。

展示用Presetの既定値は`mild`です。
起動時は`VITE_AUDIO_PRESET=off|mild|aggressive`で変更できます。
URLの`?audioPreset=off`、`?audioPreset=mild`、`?audioPreset=aggressive`は、起動時設定より優先します。
PresetをURLで変更した場合は、ページを再読み込みしてください。
通常展示にはPreset操作UIを表示しません。
Audio LabのDebug panelでは、現在のPresetを読み取り専用で表示します。
Presetの比較手順は[`docs/evaluation/voice-audio-lab.md`](docs/evaluation/voice-audio-lab.md)を参照してください。

Mode B/Cの無音終了は`600ms`が既定値です。
Audio Labでは`?audioEndpoint=400`または`?audioEndpoint=600`で比較できます。
URLの変更後はページを再読み込みしてください。
`VITE_AUDIO_ENDPOINT_MS=400|600`でも起動時の既定値を変更できます。
優先順位は`URL query > VITE_AUDIO_ENDPOINT_MS > 600ms`です。
Mode DはAudio Labでだけ選べる実験Modeです。
Mode D（Exhibition Mix）の実効endpointは`400ms`です。

展示用STTは`medium / CUDA / float16`を主プロファイルにします。
展示起動では主プロファイルのロードに失敗すると起動を失敗させます。
`tiny / CPU / int8`は明示的な比較実行だけに残します。
既定のdecodeは`beam_size=1`、`temperature=(0.0,)`、
`without_timestamps=True`、`condition_on_previous_text=False`、
`vad_filter=False`です。
既定hotwordsは`Vayria GPT-Live Codex`です。
実効model、device、compute type、fallback理由、model load時間、decode設定はAudio LabとJSONLへ記録します。
固定音声評価は[`tools/stt/benchmarks/README.md`](tools/stt/benchmarks/README.md)を参照してください。

Sessionはページ内だけの一時状態です。
履歴、話題、直前のVayria発話、演者状態、カードのターン状態を含みます。
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
- 展示音声入力を使う場合は、Python 3.12 と `uv`
- 展示HTTPSを使う場合は、`mkcert`

## セットアップ

1. 依存関係をインストールします。

   ```powershell
   npm install
   ```

2. `.env.example` を `.env.local` へコピーします。

   ```powershell
   Copy-Item -LiteralPath '.env.example' -Destination '.env.local'
   ```

   `.env.local`にはAPI keyを記述しません。
   OpenAI API keyは、専用の1Password起動コマンドから実行時だけ注入します。

3. zonoko モデルを追加した AivisSpeech CLIを起動します。

   ランチャーは次の優先順位でAivisSpeechのインストール先を選びます。

   1. `-AivisInstallPath`引数
   2. `VAYRIA_AIVIS_INSTALL_PATH`環境変数
   3. `%USERPROFILE%\.vayria\apps\AivisSpeech-1.1.0-dev`
   4. `%LOCALAPPDATA%\Programs\AivisSpeech`

   現在のPCの通常インストールを使う場合は、次のように設定できます。

   ```powershell
   $env:VAYRIA_AIVIS_INSTALL_PATH = "$env:LOCALAPPDATA\Programs\AivisSpeech"
   pwsh -NoProfile -File .\scripts\Start-VayriaAivisSpeech.ps1
   ```

   一時的に引数で指定することもできます。

   ```powershell
   pwsh -NoProfile -File .\scripts\Start-VayriaAivisSpeech.ps1 `
     -AivisInstallPath "$env:LOCALAPPDATA\Programs\AivisSpeech"
   ```

   ランチャーはインストール先から`run.exe`を解決します。
   `.vayria`配下のポータブル配置と、`%LOCALAPPDATA%\Programs\AivisSpeech`配下の通常配置に対応します。
   `VAYRIA_AIVIS_INSTALL_PATH`はPowerShellランチャーが読む値です。
   `.env.local`はViteのNode設定であり、PowerShellランチャーへ自動継承されないため、インストール先には使いません。

   起動スクリプトは `http://127.0.0.1:10101/speakers` でzonokoの存在を確認します。
   既にzonokoを提供するAivisが起動中なら再利用します。
   初回起動ではCPU起動とWindows側の処理により、Aivisの起動確認まで最大60秒待機します。
   GUI版AivisSpeechとCLIは同じ10101番ポートを使うため、同時に起動しません。
   APIの詳細は `http://127.0.0.1:10101/docs` でも確認できます。

4. 1Password CLIとデスクトップアプリ連携を設定します。

   1Passwordデスクトップアプリの設定で「Integrate with 1Password CLI」を有効にし、
   PowerShellでサインインします。

   ```powershell
   op signin
   ```

   既にサインイン済みなら、この手順はスキップできます。

5. OpenAI API keyを保存した1Password項目を選び、参照だけを保存します。

   ```powershell
   pwsh -NoProfile -File .\scripts\Configure-VayriaOnePassword.ps1
   ```

   1PasswordアプリでOpenAI API keyフィールドのメニューからSecret Referenceをコピーし、
   スクリプトのプロンプトへ貼り付けます。
   スクリプトは項目一覧を取得しません。
   `%USERPROFILE%\.vayria\vayria-op.env`へ保存されるのは次の`op://`参照だけです。
   API key本体は保存・表示しません。

   ```dotenv
   OPENAI_API_KEY=op://Vault/Item/Field
   ```

   Aivis Cloudを使う場合は、Cloud API keyの参照も任意で追加できます。

   ```powershell
   pwsh -NoProfile -File .\scripts\Configure-VayriaOnePassword.ps1 `
     -AivisCloudSecretReference 'op://Vault/AivisCloud/Field'
   ```

   参照ファイルには、次の2行が保存されます。

   ```dotenv
   OPENAI_API_KEY=op://Vault/OpenAI/Field
   AIVIS_CLOUD_API_KEY=op://Vault/AivisCloud/Field
   ```

   `op://`の右辺をAPI key本体へ置き換えないでください。
   新しいworktreeへ`.env`ファイルをコピーする必要はありません。

6. `.env.local`には秘密情報ではないTTS設定だけを記述します。

   ```dotenv
   VAYRIA_HTTPS_CONFIG_FILE=
   VAYRIA_TTS_BACKEND=cloud-with-fallback
   AIVIS_BASE_URL=http://127.0.0.1:10101
   AIVIS_SPEED_SCALE=1.15
   AIVIS_PITCH_SCALE=0
   AIVIS_INTONATION_SCALE=1.0
   AIVIS_TEMPO_DYNAMICS_SCALE=1.0
   AIVIS_CLOUD_BASE_URL=https://api.aivis-project.com
   AIVIS_CLOUD_MODEL_UUID=
   ```

   `VAYRIA_HTTPS_CONFIG_FILE`を設定した場合、共有ファイルのHTTPS設定を優先します。
   `VAYRIA_HTTPS_CONFIG_FILE`を設定しない場合は、既存の`VAYRIA_HTTPS_*`直接設定を使用します。

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

   `VAYRIA_TTS_BACKEND`の既定値は`cloud-with-fallback`です。
   このモードはAivis Cloudを優先します。
   Cloudのfirst audioが2秒以内に届かない場合は、Local AivisSpeechへ1回だけ切り替えます。
   Cloudの最初の音声chunkを送信した後にstreamが切断した場合は、重複発話を防ぐためLocalへ切り替えません。
   `local`と`aivis-cloud`は単独providerモードとして使用できます。
   Cloudを使う場合は対象のmodel UUIDを設定します。
   設定変更後は開発サーバーを再起動します。
   `AIVIS_CLOUD_API_KEY`は`.env.local`へ書きません。
   server processは1Password起動時のprocess environmentだけからkeyを読みます。

7. 展示音声入力用のPython環境を作成します。

   ```powershell
   Push-Location tools/stt
   uv sync --group dev
   Pop-Location
   ```

   Pythonサービスの設定と起動方法は [`tools/stt/README.md`](tools/stt/README.md) を参照してください。

8. worktreeごとに`.env.local`を作成して、APIを起動します。

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
   npm run dev:op
   ```

   Setup scriptはAPIを起動しません。
   ActionがworktreeごとのAPIを1Password経由で起動します。
   local開発では、`main`は`5187`を使用します。
   worker worktreeは`5188`から`5210`の空きポートを自動で使用します。
   Setup scriptはworktreeごとの`.env.exhibition.local`も自動で生成します。
   実機用の`.env.exhibition.local`は、worktreeに関係なく`5187`を使用します。
   `.env.exhibition.example`を毎回コピーする必要はありません。
   既存の`.env.local`は上書きしません。
   `.env.local`には実キーを保存しません。
   `%USERPROFILE%\.vayria\https.env`が存在する場合、Setup scriptは同じHTTPS設定ファイルの絶対パスを各worktreeへ記録します。

   CodexアプリのSettingsでLocal environmentを作成し、アプリが生成したプロジェクト`.codex`設定を確認します。
   設定スキーマは手書きしません。
   `.codex`設定には認証情報やAPIキーを含めません。
   `.worktreeinclude`には`.env.local`を追加しません。

   Codexを使わない場合は、次のラッパーでAPI keyをコピーせずにworktreeの設定を作成できます。
   その後、対象worktreeで`npm run dev:op`を起動します。

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

   local開発では、`main`は`5187`を使用します。
   各worker worktreeは`5188`から`5210`の未使用ポートを使用します。
   実機用のexhibition起動は、常に`5187`を使用します。

9. VRMの正本をGitリポジトリの外へ保存します。

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

10. 開発サーバーを起動します。

   ```powershell
   npm run dev:op
   ```

   OpenAI APIを使わない画面確認だけなら、`npm run dev`でも起動できます。

11. `http://127.0.0.1:5187/` をブラウザーで開きます。

## モーションライブラリ

保存済み VRMA は `public/avatar/motions/manifest.json` で管理します。

manifest の `assetId`、SHA-256、duration、tag、補正 profile ID が、再生 asset の契約です。

現在の manifest には、Card Pool用18本と通常発話用1本の保存済みVRMAが登録されています。

通常発話の既定主動作は `speech-gentle` です。手元を中心とした穏やかな身体動作を使います。

発話前は、視線・呼吸・微細な揺れを手続き型の前反応として使います。VRMAの開始は180msでIdleからクロスフェードします。音声終了後は250msの余韻を保持し、その後400msでVRMAからIdleへ戻ります。再生中はVRMA単独です。

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
| `exhibition` | Windows PC と iPad の専用Hotspot接続 | 検出したHotspot IPv4:5187 |
| `public` | 将来の HTTPS 公開 | 今回は公開サーバーを提供しません |

展示モードの主URLは`https://vayria.local:5187`です。mDNSが競合・権限・Firewallなどで利用できない場合は、起動ログと`GET /api/health`に表示される実行時検出のHotspot IPを確認します。fallback IPが証明書SANに含まれない場合は、TLS有効なURLとして表示せず、主URLの復旧または現在のIPを含む証明書の再生成が必要です。Internet断でも`localNetwork`とローカルUIは維持され、`internet`だけが`unavailable`になります。

### 展示コピー

展示画面と会場パネルで使用する正本コピーです。

メインコピー：

> Vayriaに一枚、どうぞ。

補助コピー：

> 気になるカードを一枚、Vayriaの脳内へ。

### iPad 展示の確認

1. `.env.example` を `.env.local` へコピーし、AivisSpeechの設定を記述します。
   OpenAI API keyは`.env.local`へ書かず、セットアップの1Password手順で構成します。
2. worktreeのSetup scriptが`.env.exhibition.local`を生成したことを確認します。
   `.env.exhibition.example`の手動コピーは不要です。
3. Windows PCへ`mkcert`をインストールし、`vayria.local`、`localhost`、`127.0.0.1`をSANに含む証明書を作成します。

   ```powershell
   mkcert -install
   New-Item -ItemType Directory -Force -Path 'C:\Users\<Windowsユーザー名>\.vayria\tls'
   mkcert `
     -cert-file 'C:\Users\<Windowsユーザー名>\.vayria\tls\vayria-cert.pem' `
     -key-file 'C:\Users\<Windowsユーザー名>\.vayria\tls\vayria-key.pem' `
     vayria.local localhost 127.0.0.1
   ```

   `mkcert -CAROOT`が返す公開ルートCA（通常は`rootCA.pem`）だけをiPadへインストールします。`rootCA-key.pem`、証明書の秘密鍵、HTTPS設定ファイルはiPadへコピーしません。
   iPadの「設定 > 一般 > 情報 > 証明書信頼設定」でルートCAを信頼します。

4. 共有HTTPS設定ファイルを一度だけ作成します。

   既定のパスは`C:\Users\<Windowsユーザー名>\.vayria\https.env`です。
   証明書と秘密鍵はworktreeへコピーしません。

   ```dotenv
   VITE_AUDIO_PRESET=mild
   VITE_AUDIO_ENDPOINT_MS=600
   VITE_VOICE_INPUT_TRANSPORT=remote
   VAYRIA_HTTPS=true
   VAYRIA_HTTPS_CERT_FILE=C:\Users\<Windowsユーザー名>\.vayria\tls\vayria-cert.pem
   VAYRIA_HTTPS_KEY_FILE=C:\Users\<Windowsユーザー名>\.vayria\tls\vayria-key.pem
   ```

   `Setup-VayriaWorktree.ps1`は、このファイルが存在する場合に各worktreeの`.env.local`へ参照先を記録します。
   既存の`.env.local`は上書きしません。
   既存worktreeへ反映する場合は、内容を確認してから次を実行します。

   ```powershell
   pwsh -NoProfile -File .\scripts\Initialize-WorktreeEnv.ps1 `
     -WorktreePath 'C:\path\to\worktree' `
     -Port 5188 `
     -HttpsConfigFile 'C:\Users\<Windowsユーザー名>\.vayria\https.env' `
     -Force
   ```

   `VITE_VOICE_INPUT_TRANSPORT`と`VAYRIA_STT_WS_URL`は、各worktreeの`.env.exhibition.local`へ残します。

5. AivisSpeechは統合ランチャーから自動起動します。
   単独で起動する場合は `npm run aivis:start` または
   `pwsh -NoProfile -File .\scripts\Start-VayriaAivisSpeech.ps1` を使います。
   インストール先を明示する場合は、先に
   `$env:VAYRIA_AIVIS_INSTALL_PATH`を設定してください。
   `AIVIS_BASE_URL`は引き続き `http://127.0.0.1:10101` を使用します。

6. Windows SettingsでMobile Hotspotを初回設定します。SSIDは`Vayria-Exhibition`、パスワード、帯域を確認し、展示時にHotspotをONにします。Hotspotの自動ON/OFFやSSID変更はこのリポジトリから行いません。

   ```powershell
   Start-Process 'ms-settings:network-mobilehotspot'
   ```

7. 対象worktreeで、Python STTとexhibitionフロントを起動します。

   展示当日の短い手順は[`docs/exhibition-quickstart.md`](docs/exhibition-quickstart.md)を参照してください。

   ```powershell
   npm run exhibition:start:op
   ```

   このコマンドは、AivisSpeech、uv経由のPython STT、Viteを起動します。
   `:op`コマンドがVite/npmプロセスへだけOpenAI API keyを注入します。
   このコマンドは、HotspotアダプタのIPv4を毎回検出してから、検出したインターフェースだけへ展示フロントをbindします。
   Windows Terminalがある場合は、制御タブ、AivisSpeechタブ、STTタブ、Viteタブを1つのウィンドウへ作成します。
   Windows Terminalがない場合は、サービスごとのPowerShell別窓を使用します。
   AivisSpeechがzonokoを提供し、Python STTが`127.0.0.1:8787`で待ち受けた後、
   exhibitionフロントを起動します。
   起動ログに表示された`https://vayria.local:5187`をiPadで開きます。mDNSが使えない場合は、診断でfallback IPが証明書SANに含まれることを確認できたときだけfallback URLを使います。iPadは会場Wi-Fiへ接続せず、`Vayria-Exhibition`だけに接続します。
   制御タブで`Ctrl+C`を押すと、このコマンドが起動したサービスの親子プロセスを停止します。
   サービスタブで`Ctrl+C`を押すと、そのサービスだけを停止します。
   既に正常なAivisSpeechが起動中の場合は再利用し、そのプロセスは停止しません。
   AivisSpeechが別のプロセスで10101番を使用している場合や、既に8787番ポートが使用中の場合は、
   既存プロセスを停止せずにエラーを表示します。

   手動で起動する場合は、次の3つのPowerShell窓を使用します。手動起動時は、ViteのbindとHotspot IPが一致していることを`npm run exhibition:check`で確認してください。

   ```powershell
   pwsh -NoProfile -File .\scripts\Start-VayriaAivisSpeech.ps1
   ```

   ```powershell
   Push-Location tools/stt
   $env:Path = "$env:USERPROFILE\.vayria\cuda12;$env:Path"
   uv run --no-sync --no-cache python -m vayria_stt.server `
     --model medium `
     --device cuda `
     --compute-type float16 `
     --beam-size 1 `
     --temperatures 0 `
     --hotwords "Vayria GPT-Live Codex" `
     --require-primary-profile `
     --fallback-model tiny `
     --fallback-device cpu `
     --fallback-compute-type int8
   Pop-Location
   ```

   ```powershell
   npm run dev:exhibition:op
   ```

   手動起動時は、ViteのbindとHotspot IPが一致していることを`npm run exhibition:check`で確認してください。

8. Vite が表示する主URLを`https`でiPadから開きます。

   ```text
   https://vayria.local:5187/
   ```

   mDNSが利用できない場合は、`npm run exhibition:check`でfallback IPが証明書SANに含まれることを確認した場合だけ、起動ログのfallback URLを使用します。
   fallback IPが証明書SANにない場合は、fallback URLをTLS有効なURLとして表示しません。
   iPadは`Vayria-Exhibition`だけに接続し、会場Wi-Fiへ接続しません。

実機用のexhibition設定は、worktreeに関係なく`5187`を使用します。
通常のlocal開発だけが、worker worktreeごとに`5188`から`5210`のポートを使用します。

### 展示中の受動ログとOwner観察

`npm run dev:exhibition`は、起動から停止までを1つの展示キャプチャとして保存します。
通常の`npm run dev`は展示キャプチャを保存しません。
来場者へ入力、確認画面、匿名ID表示、QR操作は追加しません。

端末1で展示を起動します。

```powershell
npm run dev:exhibition
```

Viteのターミナルに表示された`captureId`を使い、端末2でOwner観察CLIを起動します。

```powershell
npm run exhibition:observe -- --capture-id <captureId>
```

最新の展示キャプチャを選ぶ場合は、次を使います。

```powershell
npm run exhibition:observe -- --latest
```

展示中は、次の短い入力だけを保存できます。

```text
note <短文>
score <axis> <0|1|2|3|N/A> [reason]
```

`axis`は`presence`、`timing`、`continuity`、`emotion`、`embodiment`です。
`N/A`には理由が必要です。
メモと理由は500文字以内です。
`exit`で観察CLIを終了しても、既存データは削除しません。
Viteを`Ctrl+C`で停止しても、キャプチャは保存先に残ります。

展示停止後に、JSON集計とCSV行データを生成します。

```powershell
npm run exhibition:export -- --capture-id <captureId>
```

保存先は`VAYRIA_PLAYCHECK_ROOT`配下の次です。

```text
playcheck-results/local/exhibition/<captureId>/
  metadata.json
  events.jsonl
  observations.jsonl
  export/summary.json
  export/rows.csv
```

展示イベントには発話本文、履歴、API key、個人情報を保存しません。
Ownerも、メモと理由へ発話本文、履歴、API key、個人情報を貼り付けません。
`playcheckRunId`がある既存のPlaycheckイベントは、従来のraw保存を優先します。
`public`モードのユーザー入力は今回実装しません。

展示前に、読み取り専用診断を実行します。

```powershell
npm run exhibition:check
```

診断はHTTPS/SAN、bind/port、Hotspotアダプタ/IP、PrivateスコープのFirewall TCP `5187`・UDP `5353`、mDNS、Internet、health、AivisSpeechのzonoko、Python STTを確認します。失敗時は次に行う操作を表示します。`Get-NetFirewallRule`で確認できない場合は、PowerShellを管理者として再実行してください。

Firewallルールを初回だけ手動作成する場合は、診断が表示するHotspotインターフェース名を使い、Privateプロファイルと`LocalSubnet`に限定します。Publicプロファイル全体への許可やInternetへのポート転送は設定しないでください。

```powershell
New-NetFirewallRule -DisplayName 'Vayria Exhibition TCP 5187 (Private)' -Direction Inbound -Action Allow -Protocol TCP -LocalPort 5187 -Profile Private -InterfaceAlias '<Hotspotインターフェース名>' -RemoteAddress LocalSubnet
New-NetFirewallRule -DisplayName 'Vayria Exhibition mDNS UDP 5353 (Private)' -Direction Inbound -Action Allow -Protocol UDP -LocalPort 5353 -Profile Private -InterfaceAlias '<Hotspotインターフェース名>' -RemoteAddress LocalSubnet
```

`VITE_API_BASE_URL=/` は現在のページと同じ接続先を使用します。別の HTTPS API を使用する場合だけ、`VITE_API_BASE_URL` を変更します。

`public` モードは将来の公開用設定名です。公開 URL、公開中継、認証、永続セッション管理は今回の対象外です。
展示音声入力は`getUserMedia()`を使用します。HTTPSページでマイク許可を与えてください。
Pythonサービスは`127.0.0.1`だけで待ち受けます。iPadからPythonポートへ直接接続しません。

`.env.local`、`public/avatar/*.vrm`、生成途中の motion asset は Git の追跡対象外です。
`.env.exhibition` と `.env.exhibition.local` も Git の追跡対象外です。
VRMの正本もGitリポジトリの外に置きます。`.worktreeinclude`には追加しません。
API keyは`:op`コマンドからViteのNode middlewareへ一時的に渡し、AivisSpeechの設定はNode middlewareだけが読みます。
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

## TTS TTFA比較

通常UIからリンクしない開発用ページを用意しています。
開発サーバーを起動し、`/tts-benchmark.html`を開きます。

ページ上段のlip sync診断は、次の再生経路を比較します。

- MP3をMediaSourceへstream転送する経路
- MP3を全取得して永続Audio要素のBlob URLで再生する経路
- MP3を全取得してAudioBufferSourceNodeで再生する経路

各経路は短文、通常文、長文をwarm-up 1回、計測3回実行します。
RMSが`0.0001`を3 frame連続で超えると、有効な解析値として記録します。
診断JSONはbrowser内時刻とRMS統計だけを保存します。
物理スピーカーの出力時刻、発話本文、秘密情報は保存しません。

ページは短文、通常文、長文を直列で再生します。
各fixtureはwarm-upを1回実行します。
その後、10回を計測します。
結果はTTFA、first-audio latency、total synthesis timeのp50とp95です。

計測ページはproductionと同じ`/api/tts`と再生経路を使います。
backendはserver environmentだけで選択します。
ページからbackend、model、API keyは変更できません。
download JSONは`schemaVersion: 1`を使います。
JSONには発話本文と秘密情報を含めません。
fallbackが発生した場合、画面は回数と安全な失敗分類を表示します。
JSONは各sampleへ任意の`fallback` fieldを保存します。

Aivis Cloudのprovider failureとfallbackはmock serverを使って検証します。
iPad Safariの実測結果は[`docs/evaluation/tts-ttfa-aivis-cloud.md`](docs/evaluation/tts-ttfa-aivis-cloud.md)へ記録しています。
展示用ノートPC、本番予定network、実通信切断のOwner Playcheckは未完了です。

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

固定7ケースと5軸rubricで、AITuberの自然さをOwnerが確認できます。
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

展示モードでiPadを使う場合は、次のコマンドを実行します。

```powershell
npm run playcheck:ipad
```

このコマンドは、exhibitionモードのViteを起動します。
Viteの`Network` URLから評価runとQRページを作成します。
QRページをPCの既定ブラウザーで開きます。
iPadのカメラでQRコードを読み取ります。
iPadとWindows PCは同じLANに接続してください。
複数の`Network` URLがある場合は、先頭URLをQRに使います。
他のURLはCLIに表示します。
QRページを自動で開かない場合は、次を使います。

```powershell
npm run playcheck:ipad -- --no-open-qr
```

その場合は、CLIに表示された`QR page`のパスをPCのブラウザーで開きます。
CLIは`runId`、`playcheckRunId`付きURL、採点コマンドを表示します。
同じrun IDを指定して、PCで対話式採点を開始します。

```powershell
npm run playcheck -- score --run-id <runId>
```

CLIは7ケースの前提、操作、観察点を表示します。
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

`input_received`、`llm_start`、`llm_done`、`tts_start`、`tts_fallback_started`、
`tts_fallback_completed`、`tts_first_audio`、
`tts_ready`、`playback_started`、`tts_completed`、
`motion_ready`、`motion_start`、`animation_start`、`turn_completed`、
`turn_aborted`、`turn_failed`

ログはブラウザーのコンソールとViteのターミナルへ出力します。
入力本文、返答本文、履歴、API keyはイベントログへ含めません。
`animation_start`は音声再生とリップシンク開始時点です。
`motion_ready`はVRMAの準備完了時点です。
`motion_start`は身体モーションの開始時点です。
発話計画は、既定でモーションを180ms先行させます。
モーションは既定で180msかけて開始し、音声終了後250msの余韻の後、400msかけてIdleへ戻ります。
VRMAの準備が1200msを超えた場合は、音声のみを再生します。
通常発話の既定assetは`speech-gentle`です。カードプレビューが別のassetを指定した場合は、そのassetを優先します。

各provider requestは`X-Performer-Turn-Id`で会話イベントと関連付けます。
serverは既存clientの`X-Wildcard-Turn-Id`も互換目的で受理します。
`/api/events`は開発時の構造化イベントを受け取り、providerの同時実行数も記録します。

## 現時点で実装しないもの

- 会話履歴と長期記憶
- 配信、認証、DB
- provider とキャラクターの選択 UI
- カードのweight、TTL、コスト、自動ランダム交換
- コメント取得、fake audience、配信サービス連携
- TTSキュー、発話分割、割り込み再開
- 話題の永続記憶
- ARDY runtime generation、自由な motion selector、複雑なVRMAタイムライン制御
- 長期的な mood、感情履歴
- production server と deployment

`npm run dev` のローカル利用と、`npm run dev:exhibition` の同一 LAN 展示確認を対象にしています。
production server、公開 URL、公開中継は対象外です。
