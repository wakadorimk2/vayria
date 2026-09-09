# 検証URLを /staging/ へ移す

2026-09-09。実装と移行手順1・2は完了。マージと配信は未実施。[事前確認記録](staging-url-preflight-2026-09-09.md)を参照する。

現在は本番CDも有効。このPRをマージすると検証の移行後に本番更新も動く。

## URLと状態

| 用途 | 移行後のURL |
| --- | --- |
| 一般公開 | https://vayria.me/ |
| 本番の展示端末登録 | https://vayria.me/exhibition |
| 検証 | https://vayria.me/staging/ |
| 検証の展示端末登録 | https://vayria.me/staging/exhibition |

`/staging` は308で `/staging/` へ移す。旧 `staging.vayria.me` のGET・HEADは302で対応する新URLへ移す。クエリは保持する。旧URLへのPOSTなどは409 `staging_url_moved`を返す。管理CLIは新URLを指定する。

本番Workerは `vayria-web`。検証Workerは `vayria-public-staging`。既存のDurable Object、台帳、予算、署名鍵を維持する。検証のAPI・素材・認証・画面遷移は `/staging/` 配下に置く。`/staging-other`などは検証Workerが404で拒否する。

検証Cookieは `__Host-vayria-staging` と `__Host-vayria-staging-preview`。本番と異なる名前を使う。両方ともSecure、HttpOnly、SameSite=Strict、Path=/を使う。`__Host-` CookieはPath=/が必要なため、名前と署名鍵で区別する。ブラウザー保存キーには `staging:` を付ける。本番の既存キーは変えない。

移行後は検証チケットを再入力する。旧ドメインのCookieとブラウザー設定は移送しない。必要な検証端末は再登録する。新旧の訪問者を結び付けない。既存の使用量は削除しない。

同一オリジンはブラウザーのセキュリティ境界を共有する。保存名の分離は誤操作や混線を防ぐための処理である。検証コードは本番と同じ信頼水準でレビューする。

## ローカル検証

```powershell
npm run typecheck
npm run lint
npm run test:public
npm run test:cd
npm run public:build
npm run production:check
npm run production:recovery:check
npm run staging:build
npm run public:check
```

両ビルドは `dist-public` を使う。配信対象に合うビルドを最後に作る。CDとPRパッケージの検査は異なるベースパスのビルドを拒否する。`public:dev`で検証版を開く場合も `/staging/` を使う。

ブラウザー試験は外部通信を遮断し、APIを模擬応答へ置換する。本番ビルドを `.wrangler/root-build` にコピーしてから検証ビルドを作る。既存の比較用ディレクトリがある場合は内容を確認して更新する。

```powershell
$env:VAYRIA_CHECK_BASE_PATH = '/staging'
node scripts/public-exhibition-browser-check.mjs
node scripts/staging-admission-browser-check.mjs
```

Playwrightの場所は `PLAYWRIGHT_MODULE_PATH` で指定できる。本番・検証の同一ブラウザー表示、テーマ保存、交代状態、登録後の戻り先を検査する。カード・文字会話・音声再生停止・模擬マイクの停止も検査する。実機や実AIでの確認とは区別する。

`staging-admission-browser-check.mjs`はローカルWorkerとSQLiteを使う。同じブラウザーでチケット認証、Cookie共存、再読み込み、検証認証が失われた後の本番Cookie維持を確認する。生成は無効とし、外部通信を遮断する。

## 承認後の移行

1. GitHubの配信対象SHA、Cloudflareの現在のRoute、Worker Version、検証用Turnstileの許可ホストを記録する。移行前の版の管理CLIを旧URLへ接続し、reportで現在の台帳を記録する。新しいCLIは旧URLを拒否するため、移行前の確認には使わない。資格情報は記録へ含めない。
2. 検証用Turnstileの既存サイトキーへ `vayria.me` を追加する。旧ホストは切り戻し用に残す。`node scripts/configure-turnstile.mjs --staging` は検証用ウィジェットだけを更新する。本番用キーを流用しない。この操作は外部設定を変更する。
3. 承認されたmainへマージする。mainの検証CDは `staging:build` を使う。検証Workerに `vayria.me/staging*` のRouteを追加する。既存のサブドメインCustom Domainは転送用に残す。本番CDの有効・無効設定を変更しない。
4. 検証CDのスモークで新URLの401、未認証APIの403を確認する。旧URLの302と転送先も確認する。有料生成は呼ばない。
5. ブラウザーでチケット認証、素材表示、再読み込み、展示端末の再登録を確認する。本番と検証を同時に開く。本番のCookieと台帳が維持されていることを確認する。実機の音声会話は別に確認する。

管理CLIの接続先:

```powershell
$env:VAYRIA_ADMIN_URL = 'https://vayria.me/staging'
npm run public:admin -- report
```

検証だけ、明示された管理鍵がない場合に既存の無視対象 `.wrangler/public-secrets.json`を参照する。本番は明示した管理鍵を必須とする。URLのクエリ、別ホスト、未知のパス、旧サブドメインを拒否する。HTTPリダイレクトを追跡しない。

## 切り戻し

検証の自動更新とPRプレビューを一時停止する。記録した検証Worker Versionへ戻す。追加した `vayria.me/staging*` Routeを削除する。旧サブドメインが旧版を表示することを確認する。Versionの切り戻しだけではRouteが戻ったと判断しない。

Turnstileの旧ホスト許可は保持しているため、旧版で再確認できる。Worker、Durable Object、台帳、署名鍵を削除しない。修正版またはrevertをレビューしてから検証CDを再開する。

## ローカル確認結果

2026-09-09: 公開版59件、CD20件、Router5件、Performer258件のテストが成功した。本番・検証ビルド、Workerのdry-run、型検査、lintを確認した。

Edgeの模擬会話試験で、同一ブラウザーのテーマ・参加者交代状態の分離、検証端末登録後の戻り先、カード・文字・音声停止を確認した。別のローカルWorker試験でチケット認証、Cookie共存、認証後の再読み込み、検証認証喪失後の本番Cookie維持を確認した。Cloudflareの本番ルーティング、Turnstileの実認証、実機音声は未確認。
