# vayria.me 初回公開と自動更新

この手順は公開準備の成果物。クラウド設定、本番配信、実機確認は未実施。
初回公開はOwnerの実機確認と公開承認を受けてから行う。
本番CDはリポジトリ変数 `PRODUCTION_DEPLOY_ENABLED` が未設定または `false` の間は実行しない。
`wrangler.production.jsonc` はCD用で `GENERATION_ENABLED=true` を持つ。初回の停止配信では必ずCLIで `false` を指定する。

## 公開前の確認表

各項目に確認日、対象SHA、証拠を記録する。自動テストと実機確認を分ける。

| 項目 | 完了条件 | 現在の状態 |
| --- | --- | --- |
| 対象版 | 最新mainのSHA、CI成功、stagingのVersion IDが一致する | 初回公開直前に再確認 |
| 本番CD | Repository Actions variableが未設定またはfalse。Environment variableで同名を上書きしない | クラウド未確認 |
| GitHub Environment | production。Selected branches and tagsでBranchのmainだけ許可。Required reviewersなし | 未設定・未確認 |
| 資産取得 | productionのVAYRIA_ASSETS_READ_TOKEN。非公開vayria-assetsだけのContents Read-only | 未設定・未確認 |
| Cloudflare公開 | productionのCLOUDFLARE_API_TOKEN。対象アカウントのWorkers Scripts編集と既存Custom Domain反映に必要な権限。stagingとは別の資格情報 | 未設定・未確認 |
| DNSとTLS | vayria.meの既存Custom Domainはvayria-web。HTTPSが正常。wwwは追加しない | 再確認が必要 |
| Turnstile | 本番Managed widget。許可ホストはvayria.meだけ。サイトキーは本番設定と一致。サーバーはaction=sessionを検証 | 過去の設定記録あり。現在値は未確認 |
| Worker Secrets | 下記6件を本番Workerで確認する。値をログへ出さない | 未確認 |
| 費用 | 外部API枠は日額70円・月額3500円。Cloudflare課金アラートと通知先を確認する | 未確認 |
| 素材 | 固定VRMのSHA-256とサイズ、20モーションの出典・配信条件・最終表示を確認する | 最終確認待ち |
| Owner判断 | 声と会話体験を採用できる。公開承認がある | 未確認 |

GitHubの環境制限と変数は[Environment設定](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)と[Contexts](https://docs.github.com/en/actions/reference/workflows-and-actions/contexts)に従う。
変数が存在しない場合も本番ジョブは実行しない。GitHubプランが必要なEnvironment制限を提供しない場合は、有効化前に解消する。

### 本番Secrets

| Worker Secret | 用途・保管 |
| --- | --- |
| OPENAI_API_KEY | 既存の承認済みOpenAI資格情報を安全な保管先から取得する |
| AIVIS_API_KEY | 既存の承認済みAivis資格情報。ローカルのAIVIS_CLOUD_API_KEYから名前を対応させる |
| TURNSTILE_SECRET | 本番widget専用。staging用を流用しない |
| COOKIE_SECRET | 本番専用の32バイト以上の暗号学的乱数。stagingと分離する |
| IP_SECRET | COOKIE_SECRETとも異なる本番専用の32バイト以上の暗号学的乱数 |
| ADMIN_SECRET | 他の署名鍵とも異なる本番専用の32バイト以上の暗号学的乱数 |

各署名鍵を1Passwordの本番用項目へ保存する。再実行では既存鍵を維持する。鍵を再生成するとCookieや管理資格情報が無効になる。
本番はチケットを使わないためPREVIEW_SECRETは不要。
生成APIキーと署名鍵はWorkerだけに登録する。GitHub EnvironmentのCD Secretsへ追加しない。

安全な保管先から、6件だけを含むJSONを無視対象の `.wrangler/production-secrets.json` に一時出力する。
stagingの `.wrangler/public-secrets.json` をコピーしない。ターミナルへ内容を表示しない。
本番アカウントとWorkerを確認した後、次を実行する。

```powershell
npx wrangler secret bulk .wrangler/production-secrets.json --config wrangler.production.jsonc --env-file deploy/placeholder.env
npx wrangler secret list --config wrangler.production.jsonc --env-file deploy/placeholder.env
```

終了後は保管先から再取得できることを確認し、一時ファイルだけを削除する。
管理CLIでは本番ADMIN_SECRETをVAYRIA_ADMIN_SECRETへ、URLをVAYRIA_ADMIN_URL=https://vayria.meへプロセス環境として注入する。
既存のstaging用準備スクリプトは本番鍵の準備に使わない。
`configure-turnstile.mjs`は両環境のクラウド設定を書き換える。確認だけの目的では実行しない。

### 実機確認記録

対象SHA: 未記入。staging Version ID: 未記入。確認日: 未記入。

| シナリオ | 合格条件 | 結果 |
| --- | --- | --- |
| 文字・カード・マイク | 文字送信とカード交換が成立する。マイクは明示操作で取得する。会話ストリームと発声が最後まで成立する | 未確認 |
| 連続会話 | 20セッションの結果、失敗件数、途中キャンセル、終了後の再開を記録する | 未確認 |
| 応答時間 | 初回30秒以内。音声入力終了から最初の音声まで中央値5秒以内。端末で実測する | 未確認 |
| 端末 | PC Chrome/Edge、Android Chrome、iPhone/iPad Safari。端末・OS・ブラウザー版を記録する | 未確認 |
| 音声と復帰 | マイク拒否、雑音、自己音声、タブ非表示と復帰で暴走・勝手な再取得がない | 未確認 |
| 利用枠 | 回数上限・期限切れ・予算拒否を正しく表示する。有料処理を続けない | 未確認 |

stagingの低額予算で20セッションを完了できない場合は日を分ける。予算の増額は別途承認を受ける。
stagingで変更したcard回数などを本番へ移さない。

## 初回公開

以下は実機確認と公開承認の後に実行する。公開準備の段階では実行しない。

1. Repository variableをfalseにする。本番CDの実行中・待機中ジョブがないことを確認する。
2. 準備変更を含む最新mainのクリーンなcheckoutを使う。SHAと成功済みCI・stagingのSHAを照合する。未コミットの変更を配信に混ぜない。
3. 公開前の確認表を埋める。production Environmentと専用CD Secretsを設定する。Worker Secretsを登録する。
4. 最新mainの固定素材を取得してビルドする。GH_TOKENには資産取得権限をプロセス環境で渡す。

```powershell
npm ci
node scripts/production-cd.mjs download
$env:VAYRIA_PUBLIC_VRM = '.wrangler/public-vrm/model.vrm'
npm run public:build
npm run test:cd
npm run test:public
npm run production:check
npm run production:recovery:check
npx wrangler deploy --config wrangler.production.jsonc --env-file deploy/placeholder.env --var GENERATION_ENABLED:false --dry-run
```

各コマンドの非ゼロ終了で中止する。ここまでは本番アプリを配信しない。
直前にmainのSHAと本番Custom Domainを再確認する。その後、生成停止状態で配信する。

```powershell
npx wrangler deploy --config wrangler.production.jsonc --env-file deploy/placeholder.env --var GENERATION_ENABLED:false
```

SHA、日時、Worker Version IDを記録する。画面はこの時点で準備中ページから切り替わる。
HTTPS、画面、VRM取得、GET `/api/session`のCookie往復とenabled=falseを確認する。
Turnstileを通過しても生成は有効にならない。

5. 本番管理資格情報を注入して`npm run public:admin -- report`を実行する。日額70円・月額3500円、標準の回数制限、使用量、stopped=falseを確認する。想定外の台帳があれば中止する。使用量を初期化しない。
6. Repository variableをtrueにする。ActionsのCIをmainに対して手動実行する。

```powershell
gh variable set PRODUCTION_DEPLOY_ENABLED --body true --repo wakadorimk2/vayria
gh workflow run ci.yml --ref main --repo wakadorimk2/vayria
```

CI・Python STT・Public checks → staging配信とスモーク → production配信とスモークの順に実行する。
本番設定のGENERATION_ENABLED=trueで会話が有効になる。
本番スモークはページとJavaScriptの一致、VRMのハッシュ、Cookie保持、enabled=true、stopped=falseを確認する。
GET `/api/session`は利用状態の取得であり、有料セッションの開始確認ではない。自動スモークはPOSTを送らない。
最後にOwnerが本番で声と会話を確認する。ここで初回公開の完了を記録する。

## 自動更新と復旧

有効化後はmainへのpushで同じ順序のパイプラインを実行する。手動実行も最新mainだけを許可する。
本番ジョブは直列化する。古いSHAは配信直前に拒否する。
開始済み配信は中断しない。新しいmainが配信直前の照合後に到着する短い競合期間は残る。成功した各Version IDで配信状況を確認する。
ビルド成果物・VRMはActions artifactやキャッシュへ保存しない。runner終了時に削除する。

障害時は次の順に実行する。

1. `gh variable set PRODUCTION_DEPLOY_ENABLED --body false --repo wakadorimk2/vayria`で今後の本番CDを止める。
2. Actionsで実行中・待機中の本番ジョブを確認する。変数変更は開始済みジョブを取り消さない。開始済み配信の終了とVersion IDを確認してから回復用配信を行う。未開始の待機ジョブはキャンセルする。
3. 本番管理資格情報を使い`npm run public:admin -- stop`を実行する。reportでstopped=trueを確認する。この停止は通常のCDでも解除しない。
4. 画面も戻す場合は回復用設定を配信する。

```powershell
npx wrangler deploy --config wrangler.recovery.jsonc --env-file deploy/placeholder.env
```

回復後はHTTPSと準備中ページ、全APIの503 generation_stoppedを確認する。
同じWorker・PublicUsageクラス・migrationを保持する。旧placeholderコマンド、Worker削除、DO削除、台帳リセットは使わない。
回復用設定は管理APIも停止する。再開時はCDを無効のまま、生成停止状態の本番アプリを手動配信する。
管理CLIで使用量と修正内容を確認し、resumeで台帳停止を解除する。その後CDを再び有効化してmainのCIを手動実行する。

スモークは最大5回確認する。失敗しても配信済みの場合がある。Actions summaryのVersion IDとCloudflareの状態を確認する。
自動ロールバックは行わない。スモーク失敗を理由に使用量を消さない。

## 準備段階の検証記録

2026-09-08、ローカル作業差分で確認した。

- CDテスト8件と公開テスト29件が成功した。CDテストはworkflowの条件式、対象照合、回復用台帳の一致、模擬HTTPによるスモーク成功・失敗を確認した。
- lintと公開ビルドが成功した。公開ビルド内のアプリ・Worker型検査も成功した。
- 実VRMのビルド出力が固定Releaseのハッシュ・サイズと一致した。20モーションのハッシュ照合も成功した。
- 本番設定と回復用設定のWrangler dry-runが成功した。デプロイは実行していない。
- 公開テストはサンドボックスの親ディレクトリ読み取り制限で一度失敗した。許可された制限外の再実行で成功した。
- ビルドはJavaScriptチャンクが500 kBを超える警告を出した。ビルド失敗ではない。初回応答時間は実機で別途確認する。
- 新しい本番ジョブのGitHub上での実行、クラウド設定、実API生成、本番スモーク、Owner実機確認は未実施。
