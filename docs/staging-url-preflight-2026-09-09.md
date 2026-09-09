# 検証URL移行の事前確認記録

2026-09-09。Ownerの指示に基づき、移行手順1・2を実施した。PR作成までが今回の範囲。マージとURL切り替えは未実施。

## 確認時点

- 配信設定の取得: 2026-09-09T00:54:36.832Z
- 台帳の取得開始: 2026-09-09T00:57:21.012Z
- Turnstile変更後の再確認: 2026-09-09T00:58:28.458Z
- 確認したmain: `0ff53bc17caaef3680da6068a6791260af7edc7f`。このPRへ取り込み済み。
- mainのCI: [成功run](https://github.com/wakadorimk2/vayria/actions/runs/34296961833)。配信版との対応は別途Version IDで照合する。
- `PRODUCTION_DEPLOY_ENABLED=true`をGitHubから取得した。**このPRのマージ後は、検証CDの成功に続いて本番CDも動く。** 有効状態を変更していない。

## 配信とRoute

| Worker | Version ID（100%配信） | 配信開始UTC |
| --- | --- | --- |
| vayria-web | `fcd4f015-ac68-4a5f-9d49-d1bd89740675` | 2026-09-09T00:54:06.149038Z |
| vayria-public-staging | `6bc1f5fd-d1f3-48a8-9d73-95595389f441` | 2026-09-09T00:52:43.82203Z |

- Custom Domain: `vayria.me` → `vayria-web`、`staging.vayria.me` → `vayria-public-staging`。
- ZoneのWorker Routesは変更前後とも空。`vayria.me/staging*`は未追加。
- 両WorkerのVersion IDは変更前後で一致した。WorkerのSecrets更新は実行していない。
- Durable Objectの名前空間:
  - vayria-web: `5560b2f9a8964b6b805f9beca773e097`
  - vayria-public-staging: `f55400a907d145038579af1ac0ffaf5f`

## 台帳の取得値

| 環境 | 当日API使用額 | 当月API使用額 | 日額予算 | 月額予算 | 停止 | 実行中ジョブ |
| --- | ---: | ---: | ---: | ---: | --- | ---: |
| staging | 5.325498円 | 39.617035円 | 100円 | 1000円 | false | 0 |
| production | 2.982811円 | 2.982811円 | 70円 | 3500円 | false | 0 |

- 取得時点では両環境とも展示枠0件・登録端末0件。
- reportだけを呼び出した。予算変更、停止操作、台帳初期化、有料生成は実行していない。
- 取得後の利用に伴う使用額の変化は、この記録の値に含まれない。
- 完全なreportは無視対象 `.wrangler/staging-migration-ledgers-before.json` に保存した。資格情報は含めない。
- 完全なreportのSHA-256: `57d060f1341c4eac01b5f9b1e46a02d59423218543d0d69a0396dc987bdbfeec`

## Turnstile

- 検証用サイトキー: `0x4AAAAAAErno-F0ugJTtA7B`。既存キーを維持。
- 許可ホスト: `staging.vayria.me` → `staging.vayria.me` と `vayria.me`。
- Managedモードと既存の追加オプションを保持した。更新応答のSecretが変更前と一致することをメモリー内で検査した。
- 本番用ウィジェットは変更していない。再確認でも許可ホストは `vayria.me` のみ。
- `configure-turnstile.mjs --staging`はWorkerのSecretsを書き直さず、配信を発生させない。模擬APIの回帰テストで確認した。
- [Cloudflareの更新API](https://developers.cloudflare.com/api/resources/turnstile/subresources/widgets/methods/update/)に従い、既存オプションを保持して許可ホストを追加した。

## 残る操作

- PRのCIと差分を確認する。マージには別途Ownerの承認が必要。
- マージ直前にmain、配信版、CD有効状態、台帳を再確認する。他作業の配信を上書きしない。
- マージ後に新URLの認証、旧URLの転送、素材、展示登録を確認する。Cloudflare RouteとTurnstileの実ブラウザー動作は未確認。
- 切り戻しは [移行手順](staging-url-migration.md) に従う。
