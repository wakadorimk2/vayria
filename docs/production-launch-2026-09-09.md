# vayria.me 初回公開記録

2026-09-09、日本時間。Ownerの公開承認と本番Secrets登録承認に基づいて実施した。
本番CDは有効にせず、最新mainを手動配信した。

## 配信版

| 項目 | 記録 |
| --- | --- |
| URL | https://vayria.me/ |
| Worker | `vayria-web` |
| Source SHA | `c0c26fb8beebd3d9ec46eb5c8c760022c0452666` |
| CIとstaging反映 | [mainの成功run](https://github.com/wakadorimk2/vayria/actions/runs/34257293781) |
| 生成停止での初回Version | `e78ae357-13c3-495b-b61d-171e50e7f937` |
| 生成有効Version | `043b60bd-12b1-4970-adf9-a84b4923c65e` |
| 公開後の記録日時 | 2026-09-09 02:57 JST |
| 公開後の状態 | `enabled=true`、`stopped=false` |
| 本番CD | `PRODUCTION_DEPLOY_ENABLED`は未設定。無効 |

## 設定と検証

- 本番専用のCOOKIE_SECRET、IP_SECRET、ADMIN_SECRETを生成し、1Passwordへ保管した。stagingの署名鍵は流用していない。
- 承認済みOpenAI・Aivis APIキーと、本番専用Turnstile Secretを本番Workerへ登録した。生成APIキー・管理鍵はGitHub Actionsへ渡していない。
- 本番TurnstileはManagedで、許可ホストは`vayria.me`だけ。公開アクセスチケットは不要。
- 外部API予算は日額70円・月額3,500円。本番の回数・時間制限はコードの標準値を維持した。stagingの検証用設定は転記していない。
- 公開/CDテスト、公開ビルド、本番・回復設定と生成停止設定のdry-runが成功した。固定VRMのハッシュとサイズが一致した。
- 生成停止状態でHTTPS、HTML・JavaScriptとビルドの一致、VRM、Cookie往復、セッション状態を確認した。
- 管理CLIでstopとresumeを実行した。停止状態の反映と、操作前後の台帳一致を確認した。
- 生成有効化後の本番スモークが成功した。自動検証では有料生成を呼んでいない。
- 最終自動確認時の外部API使用量は日額・月額とも0円。これは02:57 JST時点の記録であり、その後の利用分は含まない。

## Owner確認と残りの作業

- 公開前に、OwnerがiPhone 15・Chrome・本体スピーカーで、初回発話、音声会話後の音質、発話後のマイク再開について「問題なさそう」と報告した。
- 公開後に、Ownerが本番について「動いてる」と報告した。機能別の詳細結果や応答時間の実測値は未記録。
- Ownerは個人開発の初回公開条件を縮小した。20セッション、複数端末、詳細な応答時間測定、残りのキャンセル・復帰・利用枠シナリオは公開後へ繰り越す。合格済みとは扱わない。
- Cloudflare課金アラートの設定と通知先は未確認。
- 本番CDの有効化は未実施。production Environment、専用CD Secrets、main限定条件を確認してから別途実施する。

## 停止と更新

生成を止める場合は、本番ADMIN_SECRETをプロセス環境へ注入し、`VAYRIA_ADMIN_URL=https://vayria.me`で管理CLIのstopを実行する。reportで停止を確認する。
画面を戻す場合は[公開・復旧手順](./production-launch.md)に従う。WorkerやDurable Objectを削除せず、使用量を保持する。
本番CDが無効の間、mainへのマージは本番を更新しない。

署名鍵、アクセスチケット、ローカルSecretファイル、私有VRMはこの記録へ含めない。
