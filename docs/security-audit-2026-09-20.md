# Vayria セキュリティ調査・修正報告（2026-09-20 JST）

## 結論と対象

基準コミットは `5565a2499525705d0b1e164865572a397e6549fc`。依存関係、公開Web、2つのWorker、ローカルAPI、STT、CI/CDを調査した。
修正はこの作業領域に適用した。マージ、デプロイ、本番設定の変更は行っていない。

既知のnpm勧告2件を解消した。Pythonではpytestの勧告1件も解消した。
更新後のnpm全依存監査、開発依存除外監査、Python監査は検出0件だった。
**ただし、sharpに含まれるlibheifには別の勧告が残る。アプリのHEIF/AVIF読み込みを遮断して対処した。監査0件を無脆弱性の証明には使わない。**

本番ブラウザーJavaScriptはローカルビルドとバイト単位で一致した。
配信中のWorker成果物と管理設定は取得できなかった。本番Workerの現在状態は未検証として残す。

## 問題と対応

「高」「中」は、勧告の重大度または本調査の優先度を示す。コード上の問題には独自のCVSS値を付けていない。

| ID | 重大度・成立条件 | 根拠と対応 | 本番との関係 |
|---|---|---|---|
| DEP-01 | 高。古いsharpで信頼できないHEIF/AVIFを処理する場合 | `sharp 0.35.2 → 0.35.4`。Miniflare、Wrangler、対応するworkers-typesも更新。間接依存に旧sharpが残らないことを確認 | ローカル画像処理と開発ツールに存在。ローカルWorker依存グラフには不在。配信中Workerは未取得 |
| DEP-02 | 高。細工されたYAMLを読み込む場合 | `js-yaml 4.3.1 → 4.3.2`。ESLint経由も同じ修正版へ集約 | YAML読み込みはCI検証・開発用。Worker依存グラフには不在 |
| DEP-03 | 中。UNIXでpytestの一時ディレクトリ処理を悪用できるローカル利用者がいる場合 | `pytest 8.4.2 → 9.0.3`。Python 3.12でSTTテストを確認 | 開発用。公開Workerには含まれない。Windowsでの当該UNIX攻撃の成立は主張しない |
| IMG-01 | 高。libheif 1.23.2の追加勧告。画像サイズ制限だけでは解析前の問題を防げない | `server/imageProcessing.ts` で `VipsForeignLoadHeif` を遮断。アプリのsharp直接利用3か所をこの入口に統一。WindowsとUbuntuでPNG成功・無害なAVIF拒否を確認 | アプリ側は緩和済み。Miniflare内部のsharpまで置き換えたわけではない。後述の制約を参照 |
| API-01 | 高。ローカルサーバーを実行中に、外部サイトからブラウザー要求が到達する場合 | HTTP APIにOrigin検証がなく、不正Hostも入口に到達した。音声WebSocketも外部Originを受理した。共通ガードでOrigin、Host、Fetch Metadataを検証し、処理前に403を返す | ローカル・旧LAN展示経路。Cloudflare公開Workerの入口は別実装 |
| STT-01 | 中。音声送信者が処理能力を超えるデータを送る場合 | Node橋渡しのフレームを64 KiBに制限。上流接続の待機を10秒に制限。Pythonの待ち行列を4発話に制限し、超過を `stt-backpressure` として拒否。Pythonへの直接ブラウザー接続も拒否 | ローカルSTT。公開Workerは別の音声経路 |
| MEDIA-01 | 中。認証済み動画中継の上流が不正応答を返す場合 | R2保存前の中継は上流Content-Typeをそのまま返した。モックHTMLが同一オリジンの応答になった。MP4限定、32 MiB上限、10秒タイムアウト、ストリーム実測上限を追加 | 公開Workerの条件付き経路。署名・セッション・登録済みURLが必要。任意の匿名利用者がURLを指定できると判断したわけではない |

API-01はローカルHTTP/WSサーバーにブラウザー相当のヘッダーを送って再現した。
実際の外部サイトからの悪用、ブラウザーのPrivate Network Access制限の迂回、課金発生は実行していない。
MEDIA-01もモックで再現した。実際の配信事業者が悪意ある応答を返した証拠はない。

### 依存更新の選択

| 依存 | 修正前 | 修正後 |
|---|---|---|
| sharp | 0.35.2 | 0.35.4 |
| js-yaml | 4.3.1 | 4.3.2 |
| miniflare | 5.20260903.0-alpha | 5.20260910.0-alpha |
| wrangler | 4.129.0 | 4.131.0 |
| @cloudflare/workers-types | 5.20260907.1 | 5.20260910.1 |
| pytest | 8.4.2 | 9.0.3 |

レジストリ情報では、Miniflare `5.20260910.0-alpha` がsharp `0.35.4`を使う最初の9月版だった。
Wrangler `4.131.0` はそのMiniflareを固定指定する。
workers-typesの更新はWranglerのpeer dependencyを満たすために必要だった。
override、`--force`、`--legacy-peer-deps` は使っていない。
lockfileの変更はこれらと付随するsharp/libvips/workerdの各OS向けパッケージに限定した。

### libheifの残存条件

WindowsとUbuntuのsharp `0.35.4`は、ともにlibheif `1.23.2`、libvips `8.18.6`を使った。
上流の `GHSA-xrp2-63fq-jm8q` はlibheif `1.23.3`以下を影響範囲とし、`1.23.4`を修正版とする。
そのため、npmのsharp勧告が消えてもネイティブライブラリ全体の問題解消とは判断できない。

アプリはHEIFローダーを無効化する。PNGと内部生成SVGの既存処理は維持する。
無害なAVIFを生成し、メタデータ解析が拒否されることをWindows・Linuxで確認した。
メモリ破壊やスタック枯渇を起こす入力は実行していない。

Miniflareの別プロセスにはアプリのローダー設定が及ばない。
調査したWrangler設定にImagesバインディングはなく、公開Workerへのsharp混入もない。
これは現在の到達経路の評価であり、Miniflare内のlibheifを修正した証明ではない。
Images機能を追加する前には、修正版libheifを含むツールチェーンで再評価する必要がある。

## 調査範囲と判定

「確認済み」は記載した経路を調べた意味であり、未知の脆弱性の不存在を保証しない。

| 領域 | 判定 | 確認した境界・証拠 |
|---|---|---|
| npm直接・間接依存 | 問題あり→更新済み | 全体監査、開発依存除外監査、`npm ls`、lockfile差分 |
| Python依存 | 問題あり→更新済み | `uv.lock`から完全な固定依存一覧を出力し、pip-auditで照合。出力の同一PYSEC重複を独立件数に数えない |
| 画像・YAML入力 | 問題あり→修正・緩和済み | ローカル画像処理、provider出力、CIのYAML読み込み、HEIF拒否 |
| 公開認証・Cookie・招待 | 確認済み | HMAC署名、期限、purpose、visitor/session照合、HttpOnly/Secure/SameSite、preview境界。公開Workerテストで拒否と課金前の停止を確認 |
| 部屋・DO・サービス間呼び出し | 確認済み | room membership、host/guest、lease/epoch、所有者の会話slot、非公開world Worker、WorldExecutionバインディング。共有世界テストを実行 |
| 保存・R2・パストラバーサル | 確認済み | room/mediaチケット、private/sharedキャッシュ、正規表現によるID・ファイル名制約、SQLパラメーター化、preview artifactのパス検証 |
| XSS・外部取得 | 問題あり→中継修正済み | Reactのテキスト描画、HTML属性のエスケープ、限定された部屋ID、媒体ホストallowlist、公開providerのqueue origin・redirect制限、中継のContent-Type制限 |
| 課金・並行要求 | 確認済み | SQLiteの予約処理、session/job/ticket所有権、重複・期限・並行制限、予算予約、cache-only、停止・取消。公開・visual・shared testsで確認 |
| AI入力・出力 | 確認済み／限界あり | スキーマ・長さ・カード・世界変更の検証、サーバー側の署名・課金・権限境界。生成文の指示逸脱を完全に防ぐ実モデル試験は対象外 |
| ローカルHTTP・WS・STT | 問題あり→修正済み | Origin/Hostガード、64 KiBメッセージ上限、4発話の待ち行列、Python直結拒否。既定bindはloopback |
| CI/CD | 確認済み | main限定本番配信、staging成功条件、previewの同一repo・ラベル付与権限・CI判定、別deploy job、固定アバター検証、artifact検証。CDテスト28件 |
| 秘密情報・ログ | 限定確認済み | server側のキー利用、公開アセットのallowlist、計測値の制限。追跡中ソースと配信JSの代表的秘密鍵/APIキー形式の検索は一致なし |
| 配信中のフロントエンド | 確認済み | 通常のHTTPS GETとバイト比較。詳細は次節 |
| 現在のCloudflare設定・Worker成果物・既存実行ログ | 未検証 | 認証不足。GitHub履歴とローカル成果物だけを代替証拠として使う |
| 会場・iPad・実課金・侵入実績 | 対象外 | 実機試験、実モデル生成、攻撃再現、本番負荷試験は実行していない |

## 本番の読み取り確認

GitHub deployment `6500832777` は、2026-09-17の `5565a24` をproductionに配信した成功記録だった。
CI run `35211292179` のproduction job `105170499489` には、次の版が記録されていた。

- 公開Worker `vayria-web`: `3641b302-d24d-4e57-8d5e-394b637c64f9`
- 共有世界Worker: `e577b0d0-cd53-4efe-ac8f-b18301240445`

これらは過去の配信記録である。現在稼働中の版と同じとは断定しない。
Wranglerの管理API読み取りは、通常の認証設定でも `CLOUDFLARE_API_TOKEN` 不足により失敗した。
新規アカウント作成、ログイン、設定変更は行っていない。
当該CI runに取得可能なActions artifactはなかった。

2026-09-20 01:35 JSTの通常GETでは、`https://vayria.me/` とHTMLに記載されたJSがHTTP 200を返した。
配信JS `/assets/index-DcrtbK_K.js` は、この作業領域の公開ビルドとバイト単位で一致した。
SHA-256は `4f12772dc2b9bc9e2dd66c7b10c086a027e32f23d1f17ad657d0512e485fcf34`。
ブラウザー側の一致は、Worker・DO設定・秘密値の一致を証明しない。

ローカルのesbuild依存グラフは、公開Workerが51入力、共有世界Workerが13入力だった。
両方ともsharp、js-yaml、ローカル画像ハンドラーを含まなかった。
本番Workerを取得できなかったため、これはローカル成果物の証拠として扱う。

本番の通常GET応答では、CSP、HSTS、X-Content-Type-Options、Referrer-Policyを確認できなかった。
ヘッダー不足だけで悪用可能な脆弱性とは断定しない。
CSPの導入はavatar、音声、WASM等の許可先を別途検証する必要があるため、この修正で推測したポリシーを追加していない。
本番のCookie発行・session取得APIは、読み取りに見える要求にも保存処理があるため今回呼び出していない。

## 件数の差と「修正なし」

基準版の全体監査では、高14件を再現した。
勧告の起点はsharpとjs-yamlの2件だった。14件はESLint系列、Miniflare、Wrangler等の影響パッケージを含む。
開発依存を除く監査ではsharpの高1件だった。

GitHubのproduction jobの `npm ci` ログにも「4 high severity vulnerabilities」が記録されていた。
当時の監査JSONは保存されていないため、当時の内訳とレジストリ応答は復元できない。

今回、基準版のpackage.jsonとlockfileを無視対象の隔離ディレクトリへ取り出した。
同じNode 24.14.0・npm 11.9.0・依存内容で、次の差を再現した。

| 監査条件 | 結果 | 修正候補 |
|---|---|---|
| サンドボックス内・既定のユーザーキャッシュ | 高14件 | 対象4パッケージとも `false` |
| サンドボックス内・書き込み可能な一時キャッシュ | 高4件 | js-yaml、sharp経由のMiniflare、Wranglerの更新候補あり |
| 通常権限・同じ既定のユーザーキャッシュ | 高4件 | 同上 |

一時キャッシュを使う `npm ci --ignore-scripts` も高4件だった。
4パッケージはjs-yaml、sharp、Miniflare、Wranglerであり、独立した勧告は2件である。
既定キャッシュへの書き込みではEPERMも観測した。
この環境では、キャッシュへのアクセス条件が監査件数と修正候補を変えることを確認できた。
ノートPCで当時起きた差も同じ原因だったとは断定できない。

全依存監査では修正候補が `false` だったが、開発依存除外監査はsharp `0.35.4`を候補として返した。
Miniflare旧版がsharp `0.35.2`を固定指定することは確認済みである。
したがって「修正なし」を「上流の修正版が存在しない」と解釈してはいけない。
直接依存だけでなく親パッケージを更新すると、overrideなしで依存ツリー全体を修正できた。
npm内部の候補選択の全過程と、ノートPCの当時の状態は未確認である。
今後の比較には、同じlockfile・npm版・書き込み可能なキャッシュを使う。

## 検証結果

| 検証 | 結果 |
|---|---|
| npm全依存／開発依存除外の監査 | 両方とも検出0件 |
| Python固定依存のpip-audit | 更新後は検出0件 |
| `npm run typecheck` / `npm run lint` | 成功 |
| `npm test` | Nodeテスト659件成功。PowerShellの1Password・worktree検証も成功 |
| `npm run test:security` | 追加後の最終6件成功。修正前にHTTP・Host・WSと動画中継の失敗を確認 |
| `npm run test:public` | 222件成功 |
| `npm run test:cd` | 28件成功 |
| Python STT pytest | 37件成功。モデルダウンロードなし |
| 通常ビルド・公開ビルド | 成功。既存のchunk-size警告あり |
| production・world-production Worker dry-run | 両方成功。デプロイなし |
| Windows画像処理 | Node 24.14.0。PNG成功、HEIF/AVIF拒否 |
| Ubuntu画像処理 | Ubuntu 22.04、glibc 2.35、Node 20.20.1。PNG成功、HEIF/AVIF拒否 |
| 展示E2E | Edge＋Miniflareで18件成功。256秒。外部生成はモック |

Node全体テストの後に、HTTPS・mDNS・LAN・IPv6のガード確認を1件追加した。
最終6件のsecurityテストは別途実行した。重複実行分を合算して件数を水増ししていない。
Linux検証は一時ディレクトリの画像処理試験であり、Linuxで全アプリ試験を行ったわけではない。

## 互換性と残存リスク

- 公開APIのパスと保存形式は維持した。動画中継はMP4以外、過大応答、不正な部分応答を拒否する。
- ローカルAPIは外部Originと未知Hostを拒否する。loopback、実際の接続先LANアドレス、OSホスト名、`vayria.local`を許可する。未登録の独自DNS名を使う運用は追加確認が必要。
- Originなしのネイティブ利用は維持した。OriginガードはLAN利用者の認証ではない。LANへbindする場合、そのネットワークを信頼する前提が残る。
- Python STTへブラウザーから直接接続する経路は拒否する。通常の `/api/voice-stream` を使う。待ち行列の超過時は認識失敗として終了する。
- 公開部屋へのjoinとWebSocket全体について、Cloudflare側のWAF・接続制限・課金保護は確認できていない。多数の参加者を装う負荷や長期の保存量増加を抑えられるとは断定しない。
- 秘密情報検索は代表的パターンと現在のコード・配信JSに限定した。全Git履歴、アクセス不能な設定、既存本番ログの完全監査ではない。
- パッケージ監査は取得できた勧告データに依存する。ネイティブライブラリ全体のSBOM照合や、全コードの形式検証を完了したものではない。
- アプリ修正はローカル検証済みである。本番反映、実機確認、Ownerの採用判断は未実施。

再現ログと監査JSONは、この作業領域の無視対象 `.wrangler/security-*` に保存した。
トークンや実利用者の会話・音声を報告書へ保存していない。

## 出典

- [sharpの勧告](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c)
- [js-yamlの勧告](https://github.com/nodeca/js-yaml/security/advisories/GHSA-2883-xcg3-v3hh)
- [pytestの勧告](https://github.com/advisories/GHSA-6w46-j5rx-g56g)
- [libheifの追加DoS勧告](https://github.com/strukturag/libheif/security/advisories/GHSA-xrp2-63fq-jm8q)
- [libheif 1.23.4](https://github.com/strukturag/libheif/releases/tag/v1.23.4)
- [本番配信job](https://github.com/wakadorimk2/vayria/actions/runs/35211292179/job/105170499489)
