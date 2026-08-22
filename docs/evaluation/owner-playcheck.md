# Owner Playcheck

この手順は、iPadでVayriaを操作し、Windows PCの対話CLIで自然さを採点するためのローカル手順です。
評価専用UIは使いません。
Ownerは採点JSONを直接編集しません。

## 1. Vayriaを起動する

展示モードでは、PCで次を実行します。

```powershell
npm run dev:exhibition
```

Viteが表示する`Network` URLを確認します。
URLのホストには、Windows PCのLANアドレスを使います。
`127.0.0.1`はiPadからアクセスできません。

PCだけで確認する場合は、`npm run dev`と`http://127.0.0.1:5187/`を使います。

## 2. runを作る

別のPowerShellで、Viteの`Network` URLを使ってrunを作ります。

```powershell
npm run playcheck -- start --base-url http://<PCのLANアドレス>:5187/
```

CLIは次を表示します。

- `runId`
- `playcheckRunId`付きURL
- 対話式採点コマンド
- 作業状態JSONのパス
- 生イベントJSONLのパス

表示されたURLをiPadで開きます。
URLの`playcheckRunId`は変更しません。

## 3. PCで対話式採点を開始する

表示されたrun IDを使います。

```powershell
npm run playcheck -- score --run-id <runId>
```

CLIは次の順で進みます。

1. ケースの前提、操作、観察点を表示する。
2. iPadでケースを実行する。
3. PCへ戻り、Enterを押す。
4. 5軸の点数を入力する。
5. `N/A`の場合だけ理由を入力する。
6. ケースの短い所感を入力する。
7. ケースの結果を保存する。

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

## 4. 採点ルール

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

## 5. runを確定する

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
