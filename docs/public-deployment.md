# 一般公開版の実装と運用

2026-09-08。一般公開前の検証段階。
本番 `https://vayria.me/` は準備中ページを維持する。
検証用Workerは `vayria-public-staging`。本番用Workerは `vayria-web`。
各WorkerのDurable Object名前空間を分離する。
検証環境の配信版: `629144c2-f478-43c5-8874-d80bb64a37b8`。
生成はアクセスチケットとTurnstileの両方を通過した場合に有効。
初回実機試験前の管理CLIでは外部API費用0円を確認した。実機試験後の累積費用は管理CLIで再確認する。

## 構成

- `vite.public.config.ts` はローカル環境ファイルとVite APIプラグインを読み込まない。
- `scripts/prepare-public-assets.mjs` はユーザー所有VRMと登録済み20モーションを取り込む。モーションのSHA-256を照合する。
- `worker/index.ts` はセッション、文字起こし、会話ストリーム、カード反応、署名付きTTSを提供する。
- `worker/generation.ts` は既存の入力検証と会話生成を利用する。
- `server/llmExecutionScope.ts` は各LLM呼び出しと内部再試行の前に費用を予約する。通常のlocal/exhibition実行では予約処理を挿入しない。
- `worker/usage.ts` はSQLite Durable Objectで台帳を原子的に更新する。初期規模向けに1つの台帳へ集約する。台帳障害では有料処理を拒否する。
- `src/voice/cloudVoiceAdapter.ts` は発話区間を16 kHz・mono・PCM16 WAVへ変換する。自動検出と押して話す方式を使う。音声再生中は送信しない。
- 文字送信・カード交換の操作中に音声再生を準備する。セッションがなければTurnstile確認後に取得し、その操作を続ける。ページ表示だけでは開始しない。
- マイクは「マイクで話す」を押したときだけ開始する。文字とカードではマイク許可を求めない。終了、期限切れ、タブ非表示で停止する。復帰後は文字送信・カード交換・マイク操作から再開する。
- マイクを使わずテキスト入力も利用できる。ページ表示だけでは有料生成を開始しない。
- 公開版ではカードの入れ替え回数を制限しない。独立した生成反応は別の利用枠で制限する。

## 公開版の画面

公開版は展示用UIのアバター配置・カード配置・字幕スタイルを共有する。
`data-ui-mode` で表示を切り替え、公開APIの実行モードは `public` を維持する。
下部に「文字で話す」「マイクで話す」「利用状況」をまとめる。文字入力は専用ボタンから開く。
利用枠とTurnstileは下部の開閉式パネルに配置する。初回の文字送信・カード交換では必要な確認を開き、完了後に操作を続ける。確認を閉じた場合は送信せず、入力文を残す。
スマートフォンの脳内カードは顔より上に配置する。PC・タブレットでもカード幅を抑え、顔への重なりを避ける。
2026-09-08ローカル確認: 模擬認証・模擬APIで文字送信とカード交換の各1要求、マイク取得0回を確認。明示的なマイク操作のみ取得1回。認証キャンセル時は入力文を保持した。実API音声とiPhone Chromeの実機確認は別途必要。
390×844と820×1180のブラウザー表示を確認した。変更後の実機操作は追加確認が必要。
精度とUIの細部調整は後続作業とする。

## 匿名Cookieと利用枠

`__Host-vayria` は暗号学的乱数のvisitor IDを含む署名付きCookie。
Secure、HttpOnly、SameSite=Strict、Path=/、90日。localStorageへ複製しない。
GET `/api/session` を再度呼んでCookieの保持を確認する。Cookieがなければ開始を拒否する。
POSTでTurnstileの成功、ホスト名、action=`session`を検証する。
既存の有効セッションには同じvisitorから復帰できる。
DELETEで終了する。未課金の予約は終了・期限切れ時に返す。

初期値は `worker/ledger.ts` の `DEFAULT_LIMITS` を参照する。
visitorは日2回・月10回。セッションは180秒。
ユーザー生成6回、自律生成2回、独立カード生成2回。
STTは8回・各20秒・合計120秒。TTSは20回・合計600文字。
同時生成は5セッション。同じセッションの会話処理は1件。
返答ストリームのTTSは会話生成と重なってよい。TTS同士は直列化する。

日・月の境界はJST。設定変更は使用済みカウンターを消さない。
IPはCloudflareの接続元情報だけを使う。日付付きHMACを保存する。
IP開始試行は分10回、開始成功は時30回・日100回。時間窓の終了で解除する。
共有回線を個人とはみなさない。Cookie削除と別ブラウザーの完全な回避防止は行わない。

終了したセッション詳細は終了時刻から24時間を期限とする。
日次カウンターは期間終了後48時間、月次カウンターは月末後7日を期限とする。
読み取り・更新・Durable Object alarmで期限を処理する。
会話本文、音声、生IPを台帳へ保存しない。
要求種別、処理時間、失敗種別は直近24時間・最大2000件のメタデータとして保存する。
管理CLIの中央値はAPI処理時間。ユーザーが聞くまでの遅延とは異なる。

## 検証環境

URL: `https://staging.vayria.me/`。
アクセスチケットを入力する。未承認では画面とVRMも取得できない。
管理APIは別の署名付き管理資格情報を検証する。
`workers.dev` とpreview URLsは無効。
検証環境の台帳は2026-09-08 13:58 JSTに日額100円・月額1,000円へ緩和した。時間・回数と復元値は以下の「検証環境の利用枠緩和」を参照する。
本番の外部API枠は日額70円・月額3500円。自動的に拡大しない。

ローカル実行:

```powershell
npm run public:build
npm run test:public
npm run public:check
npm run public:dev
```

`public:dev` は秘密情報を読み込まないため、標準状態では有料APIを利用できない。
マイクを含む接続試験では検証環境を使う。
ローカル専用鍵で試す場合は、無視対象のenvファイルを明示し、`--var REQUIRE_PREVIEW_ACCESS:false`を指定する。
本物のAPIキーをVite環境変数へ設定しない。

## 資格情報と話者

Turnstileは検証用と本番用を分離して設定済み（2026-09-08）。
両方ともManagedモード。各Workerへ `TURNSTILE_SECRET` を登録した。

| 用途 | 許可ホスト | サイトキー |
| --- | --- | --- |
| 検証 | `staging.vayria.me` | `0x4AAAAAAErno-F0ugJTtA7B` |
| 本番 | `vayria.me` | `0x4AAAAAAErpgvhBvYpnRm71` |

`node scripts/configure-turnstile.mjs` で同名ウィジェットを再利用し、各WorkerのSecretと設定ファイルを揃える。
本番用のサイトキーは `wrangler.production.jsonc` に設定した。本番アプリへの切り替えは実施していない。
検証環境では無効なトークンをHTTP 403 `challenge_failed`で拒否した。
ユーザー提供のiPhone画面でTurnstile成功、セッション開始、マイク許可、認識文字と返答文字を確認した。音声の聴感と連続会話の安定性は未確認。

既存の1Password参照を使って、検証用TurnstileとSecretsファイルを準備した。
`scripts/prepare-public-cloud.mjs` は同名の検証用ウィジェットを再利用する。
再実行時は既存の署名鍵を維持する。アクセスチケットは24時間有効。

```powershell
pwsh -NoProfile -File .\scripts\Start-VayriaWithOnePassword.ps1 -CommandPath node.exe -CommandArguments 'scripts/prepare-public-cloud.mjs'
npx wrangler secret bulk .wrangler/public-secrets.json --config wrangler.public.jsonc --env-file deploy/placeholder.env
```

Secrets: `OPENAI_API_KEY`, `AIVIS_API_KEY`, `TURNSTILE_SECRET`, `COOKIE_SECRET`, `IP_SECRET`, `ADMIN_SECRET`, `PREVIEW_SECRET`。
`.wrangler/public-secrets.json` は機密情報。Gitへ追加しない。削除前に安全な保管先を確保する。
`.wrangler/public-preview-ticket.txt` を検証画面へ貼り付ける。URLのクエリには入れない。
本番では検証環境と異なる署名鍵、Turnstile設定、台帳を使用する。

話者のAPIメタデータを2026-09-08に確認した。

| 項目 | 値 |
| --- | --- |
| モデル | zonoko / zgock |
| モデルUUID | `7fc08a41-b64d-456d-8b22-8e1284674775` |
| ユーザー指定の話者UUID | `8e2dfde9-a155-4bd8-b451-80832ad5e8ac` |
| スタイル | ノーマル、A、B、C、D |
| 配布元のライセンス表示 | CC0 |
| 試聴・採用確定 | Owner Playcheck待ち |

[モデル情報](https://hub.aivis-project.com/aivm-models/7fc08a41-b64d-456d-8b22-8e1284674775)。
VRM作者はわかどり。今回のアプリ配信はユーザーが指定した範囲。
第三者への再利用許諾を追加しない。モーションの出典・条件の最終確認も公開ゲートに残す。

## 費用管理

費用は整数のmicro-yenで保持する。1円は1000000。
LLMはUTF-8入力サイズに余裕を加えたトークン上限と出力上限を予約する。
成功後にproviderのusageで精算する。usage不明や課金不明の失敗では返却しない。
STTの毎分0.003ドルは概算であり上限ではない。
STTではモデルの16000入力・2000出力トークン相当を予約し、usage取得時に精算する。
150円/ドルではSTTの予約額は4.5円。通常の実使用額とは区別する。
TTSはUTF-16文字数を使って保守的に予約し、その予約額を維持する。
予約より実使用額が多ければ生成を停止する。

2026-09-08確認: mini-transcribe入力1.25ドル/M・出力5ドル/M、Aivis従量440円/1万文字。
[OpenAI料金](https://developers.openai.com/api/docs/pricing)、[STTモデル上限](https://developers.openai.com/api/docs/models/gpt-4o-mini-transcribe)、[Aivis料金](https://aivis-project.com/cloud-api/)。
会話は既存のgpt-5-nano Standard。モデル自動切り替えと暖機を無効にする。
基盤費は推計に1000円を加える。警告2000円、目標超過3000円。
これは基盤従量料金、税、為替、他環境の利用を含む請求額の絶対保証ではない。

```powershell
$env:VAYRIA_ADMIN_URL = 'https://staging.vayria.me'
npm run public:admin -- report
npm run public:admin -- stop
npm run public:admin -- configure '{"visitorDay":2,"visitorMonth":10}'
npm run public:admin -- resume
```

検証ホストだけはローカルSecretsファイルから管理鍵を読む。
本番では安全な保管先から `VAYRIA_ADMIN_SECRET` をプロセス環境へ渡す。
`dayBudget`、`monthBudget` はmicro-yenで指定する。
Workerの `GENERATION_ENABLED=false` と台帳の `stopped=true` は独立した停止手段。
両方が生成を許可した場合だけ生成する。
Cloudflare側の課金アラートはダッシュボードで別途設定する。設定完了は未確認。

## 初回公開・自動更新と切り戻し

検証環境の更新:

```powershell
npm run public:build
npm run test:public
npm run public:check
npx wrangler deploy --config wrangler.public.jsonc --env-file deploy/placeholder.env
```

本番切り替えはOwner Playcheckと公開承認の後に行う。
本番設定・Secrets確認表・実機確認・初回の生成停止配信は[本番公開手順](production-launch.md)に従う。
本番CDは `PRODUCTION_DEPLOY_ENABLED=true` の場合だけ実行する。未設定またはfalseでは公開しない。
初回の台帳確認後にCDを有効化する。以後は同じmainのCIとstaging反映・スモーク確認が成功すると本番へ自動反映する。
`www` は追加しない。検証環境のCDは以下の手順に従う。
本番へ一般公開版を初回配信した後は、既存のplaceholderコマンドを切り戻しに使わない。

障害時は本番CDを無効化し、開始済みの配信を確認する。管理CLIで生成を停止する。
画面も戻す場合は、同じWorker・DOクラス・台帳を保持した回復用設定を使う。

```powershell
npx wrangler deploy --config wrangler.recovery.jsonc --env-file deploy/placeholder.env
```

回復用設定は準備中ページを配信し、全APIを停止する。
Durable Objectを削除しない。migrationの削除・リネームで台帳を初期化しない。
再開時は本番CDを無効のまま生成停止状態の一般公開版へ戻し、管理CLIで使用量を確認してから停止を解除する。その後CDを有効にする。

## 検証記録と残る公開ゲート

- 確認済み: 公開/Worker型検査、公開ビルド、Wrangler dry-run。
- 確認済み: 公開環境用テスト20件（台帳・計測15件、エラー表示2件、Worker統合3件）。
- 統合テストは外部APIをモックする。並列開始、並列カード生成、TTS再利用、STT、予算拒否時の外部呼び出しゼロを確認する。
- 確認済み: local/exhibition共通のperformer、voice、playback関連テスト。
- 確認済み: 検証URLのHTTPS、未承認時の画面/VRM拒否、Cookie bootstrap、台帳の低額枠。
- 確認済み: ローカル画面の1280px幅と390px幅で、カード・入力欄・利用案内の配置を確認。実機マイク試験とは区別する。
- 未確認: 実APIによる会話ストリームと音声の一連動作、途中キャンセル、20セッションの実測。
- 未確認: PC Chrome/Edge、Android Chrome、iPhone/iPad Safariでのマイク拒否、雑音、自己音声、タブ復帰。
- 未確認: 初回30秒以内、音声入力終了から最初の音声まで中央値5秒以内。
- 未確認: 声と会話体験のOwner Playcheck、モーション出典の最終表示、Cloudflare課金アラート。

上記の未確認項目を通過するまで、本番の準備中ページを維持する。

## カード検証のエラー表示と処理時間

この節のcard=20、日額10円・月額100円は以前の変更記録。現在値は「検証環境の利用枠緩和」を参照する。

HTTPとNDJSON内のエラーは同じコード対応表から表示する。カード回数、会話回数、音声枠、日額・月額枠、セッション終了、混雑、生成失敗を区別する。再開時刻は有効な retryAt がある場合だけ日本時間で表示する。再開時刻は受付の目安であり、予算や音声枠の保証ではない。

検証環境へ反映する際は、管理CLIを op run 経由で実行し、card だけを20に変更する。変更前後の report で差分を確認する。標準設定は2回のままとする。日額10円、月額100円、音声20回・600文字を変更しない。20回すべての発声を保証しない。使用量もリセットしない。

```powershell
# VAYRIA_ADMIN_URL は staging.vayria.me、VAYRIA_ADMIN_SECRET は1Password参照を設定済みとする。
op run -- node scripts/public-admin.mjs report
op run -- node scripts/public-admin.mjs configure '{"card":20}'
op run -- node scripts/public-admin.mjs report
```

管理API report の recentByKind は user / autonomous / card / transcribe / tts 別に次を返す。

- requests / started / rejected: 全件数、開始済み件数、begin時点で拒否した件数。認証・入力検証より前の拒否は含まない。
- failures: 終了コード別の失敗・拒否件数。失敗本文は保存しない。
- duration: 開始済み処理の samples / medianMs / p95Ms。拒否は0秒として混ぜない。
- timings: generationMs（生成全体）、firstSpeechUnitMs（生成開始から最初の発話単位まで）、ttsFirstByteMs（音声生成開始から最初の非空データまで）、ttsTotalMs（音声生成開始から受信終了まで）。失敗時は終了までの時間を含む。未観測は集計対象外とし、samples=0 の中央値・95パーセンタイルは null。
- llmCalls / llmRetries: 外部LLM呼び出し件数と、そのうち再試行に属する件数。actualModels は実モデルごとの要求件数。プロバイダーがモデルを返さない場合は推測しない。

中央値は昇順の中央要素（偶数は上側）、95パーセンタイルは nearest-rank。既存の recentRequests / recentFailures / recentDurationMedianMs は開始済み処理の集計として維持する。旧記録は新しい時間項目を持たない。

記録は24時間・最大2,000件。時間、回数、コード、モデルのみを許可する。会話本文、音声、APIキー、Cookie、利用者識別子は含めない。記録保存の失敗は返答を失敗させない。モデル選択・再試行・音声転送方式は変更しない。端末で声が聞こえるまでの時間は別途実機確認する。

2026-09-08にOwner承認を受けて検証環境へ反映した。Worker Version: 38b2c407-d85b-4282-a02c-e8475ea943dc。op経由でcardだけを2から20へ変更した。管理APIの再取得でcard=20、日額10円、月額100円、TTS20回・600文字、使用量8.300009円の維持を確認した。recentByKindの応答も確認した。未認証のrootは401、api/sessionは403で検証用チケットを要求する。実APIへの生成要求は送っていない。iPhone Chromeの実測と新しい処理時間の採取は、反映後の操作で確認する。

## 検証環境の利用枠緩和

2026-09-08 13:58 JST、Owner承認済みの動作確認用設定を `https://staging.vayria.me` の管理APIへ反映した。
13:58:03 JSTに変更前のreportを取得した。configure後、13:58:51 JSTのreport再取得で全設定の一致を確認した。

| 項目 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 日額予算 | 10円 | 100円 |
| 月額予算 | 100円 | 1,000円 |
| visitor開始回数／日 | 20 | 100 |
| visitor開始回数／月 | 100 | 1,000 |
| セッション時間 | 180秒 | 900秒（15分） |
| ユーザー生成 | 6回 | 100回 |
| 自律生成 | 2回 | 20回 |
| カード生成 | 20回 | 100回 |
| 音声認識 | 8回・合計120秒 | 100回・合計900秒 |
| 音声合成 | 20回・合計600文字 | 200回・合計10,000文字 |
| IP開始成功／時 | 30回 | 100回 |
| IP開始成功／日 | 100回 | 300回 |

生成・音声の枠はセッション単位。音声入力1回20秒、IP開始試行分10回、同時生成5セッションは維持した。
日額使用量と月額API使用量は、変更前後とも9.859838円。停止状態はstopped=false、実行中ジョブは0件だった。
対象外の台帳設定も一致した。本番設定、コード内の標準値、Worker配信版は変更していない。
管理鍵は1Passwordからプロセス環境へ注入した。鍵の値は記録へ含めていない。
有料生成は実行していない。実機での会話・音声確認は別途行う。

15分の期限は新しいセッションに適用される。既存セッションの期限は延長しない。
検証中はこの設定を維持する。自動期限は設けない。回数が残っていても予算到達時は停止する。
ローカルの復元用記録は `.wrangler/staging-limits-before-20260908.json`。反映後記録は `.wrangler/staging-limits-verified-20260908.json`。

復元時はstaging管理資格情報をプロセス環境へ注入し、接続先を `https://staging.vayria.me` に固定する。
reportで現在値を確認した後、今回変更した項目だけを次の値へ戻す。dayBudgetとmonthBudgetはmicro-yen単位。

```powershell
op run -- node scripts/public-admin.mjs configure '{"dayBudget":10000000,"monthBudget":100000000,"visitorDay":20,"visitorMonth":100,"sessionSeconds":180,"user":6,"autonomous":2,"card":20,"transcribe":8,"audioSeconds":120,"tts":20,"ttsChars":600,"ipHour":30,"ipDay":100}'
op run -- node scripts/public-admin.mjs report
```

復元は今回実施していない。復元時も使用量を初期化せず、停止状態を変えない。現在の使用量が復元後の予算以上なら、有料処理は拒否される。

## 検証環境のCD

GitHub ActionsのCIがmainのpushまたはmainを指定した手動実行で成功すると、Deploy stagingジョブが実行される。CI、Python STT、Public checksの3ジョブを必須とする。PRでは公開用ビルド専用の代替ファイルを使い、認証情報は渡さない。mainのデプロイでは実VRMを取得してビルドし直す。

素材は非公開リポジトリ wakadorimk2/vayria-assets のReleaseで管理する。deploy/public-vrm.jsonにタグ・ファイル名・SHA-256・サイズを固定する。モデル更新時は新しいReleaseを作り、マニフェスト変更をレビューする。既存Releaseのファイルを上書きしない。

GitHub Environment stagingには、次のSecretsを登録する。Deployment branchesはmainだけのcustom policyとし、手動承認者は設定しない。

| Secret | 用途 | 権限 |
| --- | --- | --- |
| VAYRIA_ASSETS_READ_TOKEN | 非公開Releaseのダウンロード | vayria-assetsだけ。Contents: Read-only |
| CLOUDFLARE_API_TOKEN | staging Workerのデプロイ | 対象CloudflareアカウントのWorkers Scripts編集、および既存カスタムドメイン反映に必要な権限 |

初期設定用GitHub認証はローカルのop経由で注入する。初期設定用PATを上記Secretsへ転用しない。生成APIキー、ADMIN_SECRET、COOKIE_SECRET等は既存Worker側に残す。CDはSecrets登録・台帳設定変更・Turnstile作成スクリプトを実行しない。

デプロイ直前に現在のmain SHA、checkout SHA、実VRMのハッシュ、Worker名、アカウント、単一のstagingルート、プレビュー認証を検査する。古いSHAと対象不一致は失敗終了する。デプロイは同時実行しない。開始済みデプロイは新しいpushで中断しない。

実VRM、.public-assets、dist-publicはActions artifactやキャッシュへ保存しない。runnerの終了処理で削除する。npmのキャッシュだけを使う。

成功時のActions summaryにコミットSHA、Worker Version ID、検証URLを記録する。反映後は未認証rootの401とapi/sessionの403を最大5回確認する。会話生成APIを呼ばない。スモーク確認に失敗した場合、デプロイ自体は完了している可能性があるためVersion IDを確認する。

復旧はmainへの修正またはrevertのマージで行う。自動ロールバックはしない。WorkerとDurable Objectの削除、台帳の初期化は行わない。初回導入ではPRマージ前にSecrets・非公開Releaseを用意し、マージ後のActions実行結果を確認する。
