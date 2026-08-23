# Vayria Audio Lab 手順

Audio Labは、同じ端末、同じマイク、同じ発話条件で音声入力経路を比較するための開発者向け機能です。
通常の展示画面では表示しません。

## 起動

### PC Chrome

1. Vayriaを開発モードで起動します。

   ```powershell
   npm run dev
   ```

2. `http://127.0.0.1:5187/?audioLab=1`を開きます。
3. Mode AでWeb Speechを使う場合は、Python STTサービスは不要です。
4. Mode B/C/Dを使う場合は、Python STTサービスを起動します。

   ```powershell
   Push-Location tools/stt
   uv run --no-cache python -m vayria_stt.server
   Pop-Location
   ```

### iPad Safariとホーム画面追加PWA

1. HTTPSを有効にしたexhibitionモードを起動します。
2. PCとiPadを同じLANへ接続します。
3. iPad Safariで、Viteが表示したHTTPS URLへアクセスします。
4. URLの末尾へ`?audioLab=1`を追加します。
5. マイク許可を与えます。
6. 必要な場合はSafariの共有メニューからホーム画面へ追加します。
7. Mode B/C/Dでは、PC上でPython STTサービスを起動したままにします。

HTTPS証明書とexhibitionの起動方法は、ルートのREADMEを参照してください。
Audio Labは開発ビルドでだけ有効です。
`?audioLab=1`で開くAudio Labの初期Modeは`Processed`です。
通常の`exhibition`起動も`Processed`です。
通常の`local`と`public`起動は`Baseline`です。
`Exhibition Mix`はAudio Labでだけ選べる実験Modeです。

## Exhibition Audio Preset

展示用Presetの既定値は`mild`です。
Viteの起動時設定で変更できます。

```dotenv
VITE_AUDIO_PRESET=mild
```

URLのquery parameterは、起動時設定より優先します。
URLを変更した後は、ページを再読み込みしてください。

```text
?audioPreset=off
?audioPreset=mild
?audioPreset=aggressive
```

優先順位は次です。

`URL query > VITE_AUDIO_PRESET > mild`

不正なURL値は`VITE_AUDIO_PRESET`へ戻ります。
不正な起動時設定は`mild`へ戻ります。
通常展示にはPreset操作UIを表示しません。
Audio Labでは現在のPresetを読み取り専用で確認できます。

## EndpointとSTT profile

Mode B/Cの無音終了は`600ms`が既定値です。
比較用に`400ms`を選べます。

```text
?audioEndpoint=400
?audioEndpoint=600
```

環境変数は`VITE_AUDIO_ENDPOINT_MS=400|600`です。
優先順位は`URL query > VITE_AUDIO_ENDPOINT_MS > 600ms`です。
URLまたは環境変数を変更した後は、ページを再読み込みしてください。
Audio Labのendpoint selectorはマイク停止中だけ有効です。
Mode AとMode Dはendpoint selectorの対象外です。
Mode Dは`400ms`を使います。

Python STTの展示用既定profileは次です。

```text
primary: small / CUDA / float16
fallback: tiny / CPU / int8
```

起動時にモデルをロードしてwarm-upします。
CUDAの実ロードに失敗した場合だけfallbackします。
実効model、device、compute type、fallback理由、model load時間をAudio LabとJSONLへ記録します。
比較用profileは`tiny`、`base`、`small`と`CUDA`、`CPU`の組み合わせです。

Presetの役割は次です。

- `off`: AEC、NS、AGCとブラウザー側適応RMSゲートを無効にします。PCMはPython WebRTC VADへ送ります。Python VADとbarge-inは有効です。
- `mild`: AECとNSを要求します。AGCは要求しません。threshold初期値は`0.02`です。noise floor倍率は`2.5`です。
- `aggressive`: AEC、NS、AGCを要求します。threshold初期値は`0.04`です。noise floor倍率は`3.0`です。

ブラウザーはAEC、NS、AGCの処理強度を指定できません。
要求値と実際の適用値は、MediaTrack settingsへ記録します。
`noiseSuppression`または`autoGainControl`が未適用でも、起動失敗とは解釈しません。

## Mode A/B/C/Dの比較

Audio Labパネルの操作順は次です。

`Audio mode → VAD threshold → level / score → status → summary → Export`

1. 音声入力を停止します。
2. Audio modeを選びます。
3. 音声入力を開始します。
4. 1つのテストケースを実行します。
5. 音声入力を停止します。
6. `Export JSONL`を押します。
7. 同じ距離、声量、待機時間で次のModeを実行します。

Mode変更は、マイク入力中はできません。
VAD thresholdは、音声入力中も変更できます。
初期値は`0.02`です。
UIの範囲は`0.005`から`0.2`です。
比較を始めるときは、まず初期Modeの`Processed`を確認します。
既存経路との比較では、マイクを停止してから`Baseline`を選びます。

- `Baseline`: 既存の経路を使用します。localの既定値は`SpeechRecognition`または`webkitSpeechRecognition`です。exhibitionで既存のRemote PCM設定を使う場合は、既存のPython STT経路を使用します。
- `Processed`: Remote PCMへ接続し、`echoCancellation`、`noiseSuppression`、`autoGainControl`を要求します。Python WebRTC VADを使います。
- `Processed + VAD`: ProcessedにRMSベースのブラウザー側VADを追加します。200msチャンクを使います。endpointが`600ms`なら3チャンク、`400ms`なら2チャンクでspeechを終了します。Python WebRTC VADも残します。
- `Exhibition Mix`: Presetに応じた標準AEC・NS・AGC、適応型RMSゲート、既存のPython WebRTC VAD、barge-in、TTS duckingを組み合わせます。Mode DはRemote PCM経路を使い、endpointは`400ms`です。ブラウザー側RMSゲートも200msチャンク2個でspeechを終了します。

## Mode Dの確認ポイント

Mode Dは展示環境向けの実験的な組み合わせです。
通常展示の既定Modeではありません。

1. Presetに応じて`echoCancellation`、`noiseSuppression`、`autoGainControl`を要求します。
2. SafariまたはOSが返した実値をMediaTrack settingsへ記録します。
3. `mild`と`aggressive`では、AudioWorkletの200ms PCMチャンクで適応型RMSゲートを実行します。`off`ではゲートを実行しません。
4. ゲートを通過した元のPCMだけをPython WebRTC VADへ送ります。
5. Python側のfaster-whisperへ音声を送ります。

初期のnoise floorは`0.005`です。
noise floorの更新係数は`0.05`です。
effective thresholdは`max(user threshold, noise floor * preset倍率)`です。
`mild`の倍率は`2.5`です。
`aggressive`の倍率は`3.0`です。
`off`はブラウザー側ゲートを使わないため、noise floorとeffective thresholdはUnavailableです。
speech開始は1チャンクです。
speech終了はthreshold未満3チャンクです。
candidate rejectはnoise floor未満2チャンクです。
ゲートはPCMの音量を加工しません。

全ModeでTTS再生中にspeech startを検出すると、`barge_in_candidate`へ遷移します。
候補中は、TTS音量だけを20msで約`0.12`へ下げます。
空transcript、既知誤認識、純粋な相槌は候補を破棄し、TTS音量を復元します。
内容のある確定発話だけが`confirmed_barge_in`へ進み、現在の会話ターンを停止します。
STTエラー、停止、2.5秒timeoutでもTTS音量を復元します。
TTSが先に終了した場合も、音量だけを復元して候補を確定文字列まで保持します。
TTS非再生中も、speech startだけでは現在の会話ターンを停止しません。
speech startだけでは、遅延中の非発話反応もキャンセルしません。
speech startだけでは、音声の聞き手相槌を再生せず、頷きも表示しません。確定発話後の会話行動が`backchannel`を選んだ場合だけ、音声相槌と頷きを表示します。
候補なしの忙しい状態では、内容のある確定文字列だけが現在の会話ターンを停止します。
純粋な相槌または未完発話は、汎用の`voice_interrupt`を発生させません。
Mode Dだけは、これに加えてブラウザー側の適応RMSゲートを使います。

全Modeのログにはbarge-in状態を保存します。
Mode Dのログにはnoise floor、effective threshold、最大VAD scoreも保存します。
raw audioは保存しません。

Mode B/C/DでPython STTサービスが停止している場合、音声サービス接続エラーを表示します。
Mode AのWeb Speech経路は、ブラウザーやOSの音声認識サービス差を含みます。
Mode AとMode B/CのSTTエンジンが異なる場合、マイク前処理だけの比較にはなりません。

## 低遅延の比較指標

JSONLの発話レコードには次の時刻と時間を保存します。

- `sttQueuedAt`
- `sttStartedAt`
- `sttObservedAt`
- `sttResultAt`
- `sttQueueWaitMs`
- `sttProcessingMs`
- `sttLatencyMs`
- `endpointToResultLatencyMs`
- `speechToResultLatencyMs`

`sttLatencyMs`は従来どおり、STT開始から最終結果までです。
今回の主な比較対象は、発話終了から最終STTまでの`endpointToResultLatencyMs`です。
展示用のstretch targetは`700ms以下`です。
quality profileまたはCPU fallbackが超えても、失敗とは判定しません。

## 音声LLMの呼び出し回数

通常の音声応答は、行動判定と本文生成を1回のLLM呼び出しで処理します。
応答JSONには`voiceAction`、`backchannelCue`、`text`、`emotion`、`activatedCards`を含めます。
wire上の行動名は`listen`、`backchannel`、`take_floor`を維持します。

`listen`と`backchannel`では、本文とカード発動は空です。
`take_floor`では、本文と必要なカード発動を返します。
内容のある発話を非発話反応へ分類した場合だけ、契約修正を指定して1回再試行します。

`llm_done.providerCallCount`を確認します。
通常は`1`です。
契約修正の再試行がある場合は`2`です。
`llm_done.durationMs`は、再試行を含むリクエスト全体のLLM時間です。
`providerCallCount`と`durationMs`を別々に見ると、待ち時間の増加理由を確認できます。

## TTS再生中の候補比較

Mode BとMode CのTTS回り込みを比較する場合は、次の条件を固定します。

1. 同じMode、endpoint `600ms`、同じ端末で開始します。
2. 同じTTS文、音量、再生速度、再生時間を使います。
3. TTS再生中は話しません。
4. Mode Bで10回以上繰り返します。
5. Mode Cで同じ回数を繰り返します。
6. 各セッションのJSONLをExportします。

次の値を比較します。

- `ttsActiveDurationMs`
- `ttsCandidateCount`
- `ttsAcceptedCount`
- `ttsVadRejectCount`
- `ttsNoiseLikeSttCount`
- `ttsCandidatesPerMinute`

`ttsCandidatesPerMinute`は、TTS再生時間で正規化した候補数です。
TTS再生時間が0の場合は`null`です。
Audio Labの削減率は、Processedを基準に計算します。

```text
1 - processed-vad.ttsCandidatesPerMinute
    / processed.ttsCandidatesPerMinute
```

比較元の時間が不足する場合は`Unavailable`です。
削減率が負の場合も、その値を記録します。
異なるTTS文、音量、再生時間、会場ノイズのセッションを混ぜて削減率を比較しません。

「うん」「はい」などの割り込みは、無言ケースと分けて測定します。
同じTTS文と同じ割り込み回数をMode B/Cで再現します。
`ttsAcceptedCount`は、TTS中に始まった発話のうち、VADを通過してSTTへ送った候補です。
`ttsNoiseLikeSttCount`は、その候補のうち空または既知誤認識以外のnoise-like結果です。
`ttsVadRejectCount`は、TTS中に発生したVAD rejectです。

## 固定して試す10ケース

次のケースを、同じ順番でMode B/Cのendpoint `600ms`、Mode B/Cのendpoint `400ms`へ適用します。
必要な場合だけMode AとDebug限定のMode Dを追加します。

1. 端末の近くから普通の声で話す
2. 端末から50cm程度離れて話す
3. 端末から80cm程度離れて話す
4. 小声で話す
5. 10秒程度無言で待つ
6. 周囲で別の人が話す
7. VayriaのTTS再生中に何も話さない
8. VayriaのTTS再生中にユーザーが割り込む
9. 「うん」「あー」などの短い発話を行う
10. 軽い環境ノイズを流す

ケースごとに距離、発話文、声量、TTSの文、待機時間を固定します。
Modeを変えた後に同じ条件を再現します。
各ケースのJSONLファイル名に、Modeとケース番号をメモすると比較しやすくなります。

## iPad内蔵マイクと外部マイク

iPad内蔵マイクでは、端末から話す位置を20〜40cmに固定します。
端末の向きとTTS音量を固定します。
話者の位置を固定します。

外部マイクを使う場合は、iPadOSの既定入力に設定します。
Audio Labには入力デバイス選択UIを追加していません。
指向性マイクは話者へ向けます。
マイクと話者の距離を20〜40cmに固定します。
スピーカーとマイクの距離をできるだけ離します。
マイクのdeviceIdとgroupIdは保存しません。

会場で測る場合は、次の順で確認します。

1. 会場の通常音量を再現します。
2. Mode B/Cのendpoint `600ms`と`400ms`で同じ発話文を話します。
3. TTS再生中の無言と割り込みを各Modeで試します。
4. Export JSONLで候補数、reject数、latency、barge-inを保存します。
5. Mode Dのnoise floorとeffective thresholdをケースごとに比較します。

Mode Dでも、同じ音量と同じ距離の競合話者は分離できません。
適応RMSゲートは方向を判定しません。
会場で競合話者が多い場合は、話す位置と指向性マイクが主要な対策です。

## 表示とログ

Audio Labは次を表示します。

- マイク入力状態
- VAD speech状態
- STT処理状態
- TTS再生状態
- マイクレベル
- RMS由来のVAD score
- 要求済み、対応可能、適用済みのMediaTrack settings
- 最新発話と最新エラー
- Mode別summary
- endpoint設定
- 実効STT model、device、compute type
- fallback状態とmodel load時間
- 最新発話のqueue wait、processing、endpoint-to-result、total latency

Mode AのWeb Speech経路では、マイクレベルとMediaTrack settingsを取得しません。
パネルの`Unavailable`は、その経路では値を測れないという意味です。
Mode B/C/Dでsettingsが空の場合も、ブラウザーまたはiPadOSが値を返さなかった可能性があります。
settingsは`getSettings()`で得た値を使います。
Mode Dでは、適応noise floor、effective threshold、barge-in state、TTS ducking状態も表示します。
`noiseSuppression`または`autoGainControl`が未適用でも、ブラウザーまたはiPadOSの制約です。Mode Dの起動失敗とは解釈しません。
`deviceId`と`groupId`は保存しません。

保存先は`VAYRIA_PLAYCHECK_ROOT`の下です。
未設定時の保存先は次です。

```text
playcheck-results/local/voice-lab/<sessionId>/events.jsonl
```

音声データは保存しません。
JSONLには、発話時刻、speech区間、endpoint、STT時刻、phase別latency、raw transcript、会話へ渡したtranscript、VAD判定、reject理由、TTS重複、匿名化済みsettings、STT runtime、エラーを保存します。
raw transcriptは調査ログだけに保存し、会話本文へは渡しません。
既知の誤認識メトリクスは次の3語を数えます。

- ご視聴ありがとうございました
- ありがとうございました
- ご覧いただきありがとうございました

このメトリクスは比較用です。
本番会話の固定語フィルタではありません。

## 参考コマンド

```powershell
npm run test:voice
npm run typecheck
npm run lint
npm run build
npm run test:worktree-setup
Push-Location tools/stt
uv run --no-cache pytest
Pop-Location
```
