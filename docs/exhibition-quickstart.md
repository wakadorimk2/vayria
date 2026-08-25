# Vayria展示当日クイックスタート

## 1. 起動コマンド

対象worktreeのルートで、次を実行します。

```powershell
npm run exhibition:start:op
```

このコマンドは`%USERPROFILE%\.vayria\vayria-op.env`の`op://`参照を使います。
API key本体をworktreeへ保存しません。

展示時はWindows Mobile Hotspotを有効にします。
標準URLは`https://vayria.local:5187/`です。
接続確認やmDNSの問題がある場合は、次を実行します。

```powershell
npm run exhibition:check
```

診断で証明書SANへの適合が確認できた場合だけ、表示されたfallback IP URLを使用します。

起動前に、AivisSpeech、CUDAランタイム、STT依存関係、環境設定、ポートを確認します。
`npm install`と環境ファイルのコピーは実行しません。
worktreeのSTT環境が未同期の場合は、起動時に`uv sync --locked`を実行します。

## 2. Windows Terminalタブの役割

Windows Terminalがある場合は、1つのウィンドウにサービスごとのタブを作成します。

- 制御タブ: 起動順序の表示、稼働状態の表示、全体の終了。
- AivisSpeechタブ: `127.0.0.1:10101`の音声合成。
- STTタブ: `127.0.0.1:8787`の音声認識。
- Viteタブ: 展示フロントとNode middleware。

正常なAivisSpeechが既に稼働中の場合は、AivisSpeechタブを作成せずに再利用します。
Windows Terminalがない場合は、サービスごとのPowerShell別窓を使用します。

## 3. 正常終了方法

制御タブで`Ctrl+C`を押します。

今回の起動で作成したサービスの親子プロセスを終了します。
既に稼働していたAivisSpeechは終了しません。

サービスタブで`Ctrl+C`を押すと、そのサービスだけを終了します。

## 4. ログの場所

ログは次のディレクトリへ保存します。

```text
logs/exhibition/<run-id>/
```

各サービスの`stdout`と`stderr`を別ファイルへ保存します。
制御タブの工程ログは`controller.log`です。

## 5. 工程失敗時の確認方法

制御タブの`[FAIL]`行で工程名を確認します。
表示された`stdout`と`stderr`のパスを確認します。

```text
[FAIL] STT
Reason: 127.0.0.1:8787 did not become ready.
stdout: logs/exhibition/....../stt.stdout.log
stderr: logs/exhibition/....../stt.stderr.log
Action: inspect the logs, then press Ctrl+C in the control tab.
```

ログを確認した後、制御タブで`Ctrl+C`を押して後処理を実行します。
