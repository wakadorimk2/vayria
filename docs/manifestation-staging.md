# Generated chicken objects on staging

The public staging build preserves the existing card, text, and voice UI. It adds no slot, buttons, or developer panel. Generated objects alone overlay the scene. The production build leaves it disabled. The Worker also requires `MANIFESTATION_ENABLED=true`, preview access, and the `/staging` mount. Store `FAL_KEY` and the enable flag as staging Worker secrets. Do not add them to production.

The existing conversation model considers the latest text or voice message, cards, and conversation together. Its optional structured manifestation decision is validated on the server. It defaults to none; mentions, negations, and old history do not authorize a summon. Only the final validated response triggers one visual event per turn. No extra LLM call is made. The initial supported object is a chicken; size, sparkle, and water effects modify existing objects.

The route uses fal H3 Max Turbo, 5 seconds, 480p, fast prompt expansion, the queue API, and the bundled green-screen chicken source. The browser keys the streamed video. Background generation and provider comparison are not part of this public route. The existing local experiment remains available.

`PublicUsage` persists the additive manifestation ledger alongside existing session and billing state. Each request reserves $0.125 before submission. This uses the normal $0.025/second price, not the launch promotion ([fal pricing](https://fal.ai/models/minimax/h3-max-turbo/image-to-video), checked 2026-09-10). The new cumulative cap is $5. Failed requests retain reservations. Existing daily, monthly, and exhibition budgets also apply. No deployment or browser reset replenishes the cap. Each public session permits 20 requests, with two active generation jobs. Conversation retains its separate execution slot.

The browser still finalizes a fallback at five seconds and aborts remaining work at ten seconds. A completed video becomes an opaque, visitor-bound media ticket. Media requests validate a live public session and the provider host. They forward only a validated Range header. They never forward cookies or API credentials. Media is not persisted to disk in the Worker.

## Deployment

Use the existing `staging-preview` PR label and the main-owned Staging preview workflow. The workflow checks the selected PR SHA and CI, builds without deployment credentials, verifies the pinned avatar, then deploys only `vayria-public-staging`. The current URL is `https://vayria.me/staging/`. The old staging hostname redirects there. Do not restore the obsolete hostname configuration or merge the PR to trigger production.

Record the previous Worker deployment before enabling or deploying. For rollback, restore that recorded Worker version with Wrangler against `wrangler.public.jsonc`. Do not replace the Durable Object or reset its state. Removing the PR label stops future preview updates; it does not restore a prior version.

## Evidence

Local latency evidence remains in `manifestation-latency.md`. Those measurements do not prove staging latency. Public tests cover reservation persistence, concurrency, duplicate events, quota rejection, visitor ownership, timeout rejection, fixed provider inputs, and partial video relay. Real staging speed, audio timing, and visual overlap require a separate browser run after deployment.


## UIによる配置保留（2026-09-12）

小物は配置できない間も保持する。表示中の累積時間だけで15/30/45秒の退場を進める。UIが閉じたら再表示する。OFF中は保留から復帰しない。保留も最大3対象に含める。画像から動画への置換で時計を引き継ぐ。

保護領域は非表示・空のパネルを除く。字幕、カード、入力、設定、接続・生成・エラー通知とソフトキーボードを対象にする。保留案内自身は再配置の障害物にしない。浮遊・回転が保護領域に触れる場合は動きを止める。有効な位置は保ち、優先位置への復帰は300ms安定後に行う。

### 無課金のDOM検証

`node scripts/visual-placement-fixture.mjs` で http://127.0.0.1:5198/ を開く。実際のVisualStage、領域取得、公開CSSと同梱の鶏画像を使う。アバターの投影領域は固定の疑似値。APIには接続しない。

393×665で字幕下への配置、全面UIによる保留、表示時計の停止、UIを閉じた後の復帰を確認した。852×393でも縮小表示を確認した。これはブラウザーの疑似投影であり、iPhoneの実機評価ではない。

診断のplacement_shown / placement_held / placement_resumedには対象ID、理由、表示累積時間を付ける。会話本文と素材URLは付けない。既存のイベントIDで照合する。
