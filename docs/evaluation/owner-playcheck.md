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
3. `autonomous_turn`
4. `silence_gap`
5. `continuity_variation`
6. `interruption`

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

6ケースの採点後に、同じPowerShellで実行します。

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
