# Staging visual storage

The staging Worker binds VISUAL_ASSETS to the private bucket vayria-staging-visual-assets. Production has no new binding.

Bucket lifecycle: p- objects expire after one day; s- objects expire after 30 days. The application also checks expiry. Public bucket access is disabled. The Durable Object ledger is not replaced or reset.

The normal main-owned staging preview workflow uses this binding after this infrastructure change is merged by the owner. While it is unmerged, the explicit preview command checks the application PR head, successful CI, clean source checkout, pinned VRM hash, and staging-only configuration. It records the previous deployment before publishing.

```powershell
node scripts/staging-visual-preview.mjs <application-checkout> 111 <full-verified-sha>
```

Build the application's staging assets before this command. Remove the application's staging-preview label while testing the unmerged binding, so automatic main-owned CD cannot overwrite it. Review the infrastructure PR separately. Do not merge either PR or deploy production automatically.

On failure, use the recorded Worker version with wrangler rollback for vayria-public-staging only. Preserve the Durable Object ledger and R2 bucket.
