# Owner Playcheck

この手順は、iPadでVayriaを操作し、Windows PCの対話CLIで自然さを採点するためのローカル手順です。
評価専用UIは使いません。
Ownerは採点JSONを直接編集しません。

## 展示中の受動ログとOwner観察

展示で来場者へ入力を求めません。
展示画面に確認画面、匿名ID、QR操作を追加しません。
Ownerは、展示を操作する端末とは別のPowerShellへ短文メモを入力できます。

端末1で展示を起動します。

```powershell
npm run dev:exhibition
```

Viteのターミナルに表示された`captureId`を使い、端末2で観察CLIを起動します。

```powershell
npm run exhibition:observe -- --capture-id <captureId>
```

最新のキャプチャを使う場合は、次を使います。

```powershell
npm run exhibition:observe -- --latest
```

展示中に入力できる形式は次です。

```text
note <短文>
score <axis> <0|1|2|3|N/A> [reason]
```

`axis`は既存の5軸です。
`N/A`には理由が必要です。
メモと理由は500文字以内です。
Owner入力は任意です。
入力がなくてもruntimeイベントは自動保存されます。

展示を止めた後、次でJSON集計とCSVを生成します。

```powershell
npm run exhibition:export -- --capture-id <captureId>
```

`--latest`も使用できます。

```powershell
npm run exhibition:export -- --latest
```

キャプチャは`VAYRIA_PLAYCHECK_ROOT`配下へ保存します。

```text
playcheck-results/local/exhibition/<captureId>/
  metadata.json
  events.jsonl
  observations.jsonl
  export/summary.json
  export/rows.csv
```

`Ctrl+C`でViteを停止しても、キャプチャと観察ログは削除しません。
未完了キャプチャもexportできます。
展示イベントへ発話本文、履歴、API key、個人情報は保存しません。
Ownerも、メモと理由へそれらを入力しません。

この受動ログは展示キャプチャ用です。
`playcheck:ipad`の既存の`runId`評価フローは、次の手順で継続します。

## 1. Vayriaと評価runを起動する

PCで次を実行します。

```powershell
npm run playcheck:ipad
```

このコマンドは、exhibitionモードのViteを起動します。
Viteの`Network` URLから評価runを作成します。
QRページをPCの既定ブラウザーで開きます。
iPadのカメラでQRコードを読み取ります。
iPadとWindows PCは同じLANに接続してください。
`127.0.0.1`はiPadからアクセスできません。

QRページを自動で開かない場合は、次を使います。

```powershell
npm run playcheck:ipad -- --no-open-qr
```

その場合は、CLIに表示された`QR page`のパスをPCのブラウザーで開きます。
複数の`Network` URLがある場合は、先頭URLをQRに使います。
他のURLはCLIに表示します。

PCだけで確認する場合は、`npm run dev`と`http://127.0.0.1:5187/`を使います。
CLIは次を表示します。

- `runId`
- QRページのパス
- `playcheckRunId`付きURL
- 対話式採点コマンド
- 作業状態JSONのパス
- 生イベントJSONLのパス

## 2. PCで対話式採点を開始する

表示されたrun IDを使います。

```powershell
npm run playcheck -- score --run-id <runId>
```

CLIは次の順で進みます。

1. ケースの前提、操作、観察点を表示する。
2. iPadでケースを実行する。
3. PCへ戻り、Enterを押す。
4. 自然さに関する5つの質問へ答える。
5. `N/A`の場合だけ理由を入力する。
6. ケースの短い所感を入力する。
7. ケースの結果を保存する。

採点質問は、内部の軸IDではなく、Ownerが感じた印象を答える文で表示します。

ケースは次の順で進みます。

1. `idle_presence`
2. `manual_response`
3. `voice_listener_reaction`
4. `autonomous_turn`
5. `silence_gap`
6. `continuity_variation`
7. `interruption`

`voice_listener_reaction`では、具体的な話題、感情または好み、フィラーまたは未完発話を1回ずつ試します。内容のある発話では、短い返答が話題・感情・質問意図のいずれかを拾うかを確認します。フィラーまたは未完発話では、非発話反応が維持されるかを確認します。

### 音声割り込みの実音声確認

`interruption`では、iPadのVayriaとスマホのGPT-Liveを同じ空間で使います。
GPT-Liveは、Vayriaの音声を聞く会話相手として使います。
GPT-Liveへ次の指示を伝えます。

```text
この音声セッションでは、あなた側に入る文字起こしはすべてiPadのVayriaの発話です。
観察者ではなく、Vayriaの会話相手として自然に応答してください。
Vayriaの発話中は割り込まず、発話が終わったら内容に短く返答してください。
環境音や短い相槌には反応せず、内容のある発話にだけ返答してください。
返答後はVayriaが話し始めるまで待ってください。
```

Vayriaの連続発話中にGPT-Liveが返答した場合、Vayriaが不用意に停止しないかを確認します。
GPT-Liveの返答後にVayriaが自然に続くかを確認します。
Vayriaが明示的に話しかけた場合、GPT-Liveへ自然にターンを譲るかを確認します。
多ターン確認では、少なくとも6往復を続けます。
短い相槌または沈黙が1回入ることは許容します。
同意または意味の反復が数往復続いた場合、Vayriaが質問を強制せずに小さな新しい観察、感情、感覚、話題の角度、または軽い相違を一つ出すかを確認します。
内容のある発話に対して、汎用相槌だけのtake-floor応答が残らないことを確認します。
意図的な静けさを、不要な話題転換で壊さないことも確認します。
GPT-Liveの報告とOwnerの印象を、`timing`と`continuity`の採点根拠にします。
音声、発話本文、個人情報は保存しません。

途中でCLIを終了した場合は、同じコマンドで未完了ケースから再開します。
特定ケースを再採点する場合は、次を使います。

```powershell
npm run playcheck -- score --run-id <runId> --case interruption
```

## 3. 採点ルール

各軸は次の値で入力します。

- `0`: 破綻
- `1`: 不自然
- `2`: 許容
- `3`: 自然
- `N/A`: 観測不能

`N/A`には理由が必要です。

所感は500文字以内です。
発話本文、履歴、API key、個人名、個人ハンドルは入力しません。

基準の詳細は`naturalness-rubric.md`を参照します。

## 4. runを確定する

7ケースの採点後に、同じPowerShellで実行します。

```powershell
npm run playcheck -- finalize --run-id <runId>
```

成功すると次を生成します。

- `docs/evaluation/results/runs/<date>-<runId>.json`
- `docs/evaluation/results/summary.json`

生イベントとCLIの作業状態は`playcheck-results/local/`に残ります。
このディレクトリはGit管理外です。

`finalize`は次の場合に失敗します。

- run IDが一致しない。
- 必須ケースが不足する。
- 軸IDが不明である。
- 点数が`0`〜`3`または`N/A`ではない。
- `N/A`の理由がない。
- 所感が500文字を超える。
- 生イベントがない。

結果が`fail`の場合も集計ファイルは生成されます。
その場合のCLI終了コードは1です。
結果が`incomplete`の場合のCLI終了コードは2です。
