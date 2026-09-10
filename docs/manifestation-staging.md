# Generated chicken objects on staging

The public staging build enables the single card slot. The production build leaves it disabled. The Worker also requires `MANIFESTATION_ENABLED=true`, preview access, and the `/staging` mount. Store `FAL_KEY` and the enable flag as staging Worker secrets. Do not add them to production.

The route uses fal H3 Max Turbo, 5 seconds, 480p, fast prompt expansion, the queue API, and the bundled green-screen chicken source. The browser keys the streamed video. Background generation and provider comparison are not part of this public route. The existing local experiment remains available.

`PublicUsage` persists the additive manifestation ledger alongside existing session and billing state. Each request reserves $0.125 before submission. This uses the normal $0.025/second price, not the launch promotion ([fal pricing](https://fal.ai/models/minimax/h3-max-turbo/image-to-video), checked 2026-09-10). The new cumulative cap is $5. Failed requests retain reservations. Existing daily, monthly, and exhibition budgets also apply. No deployment or browser reset replenishes the cap. Each public session permits 20 requests, with two active generation jobs. Conversation retains its separate execution slot.

The browser still finalizes a fallback at five seconds and aborts remaining work at ten seconds. A completed video becomes an opaque, visitor-bound media ticket. Media requests validate a live public session and the provider host. They forward only a validated Range header. They never forward cookies or API credentials. Media is not persisted to disk in the Worker.

## Deployment

Use the existing `staging-preview` PR label and the main-owned Staging preview workflow. The workflow checks the selected PR SHA and CI, builds without deployment credentials, verifies the pinned avatar, then deploys only `vayria-public-staging`. The current URL is `https://vayria.me/staging/`. The old staging hostname redirects there. Do not restore the obsolete hostname configuration or merge the PR to trigger production.

Record the previous Worker deployment before enabling or deploying. For rollback, restore that recorded Worker version with Wrangler against `wrangler.public.jsonc`. Do not replace the Durable Object or reset its state. Removing the PR label stops future preview updates; it does not restore a prior version.

## Evidence

Local latency evidence remains in `manifestation-latency.md`. Those measurements do not prove staging latency. Public tests cover reservation persistence, concurrency, duplicate events, quota rejection, visitor ownership, timeout rejection, fixed provider inputs, and partial video relay. Real staging speed, audio timing, and visual overlap require a separate browser run after deployment.
