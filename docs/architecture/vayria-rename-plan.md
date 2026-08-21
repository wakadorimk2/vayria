# Vayria rename plan

Status: implementation plan and naming boundary for the Vayria rename.

## 1. Naming decision

| 出典 | 目的 | 具体対象 | 役割 | 前後関係 | 候補語 | 初出定義 |
|---|---|---|---|---|---|---|
| User naming model | 最上位の識別 | AI Performer本人、プロジェクト、repository、Web入口 | 全体ブランド | Runtime、character configuration、Showsを包含する | Vayria | VayriaはAI Performerとプロジェクト全体を示す最上位ブランド |
| User naming model | showの識別 | 最初のshow、exhibition、Live Direction、card interaction system | show固有の名前 | Vayriaの下位に配置する | WildCard | WildCardはVayriaが出演する最初のshowとカード演出層 |
| `src/performer/*` and runtime docs | 技術層の再利用 | trigger、state、profile、planning、execution | ブランド非依存のRuntime | WildCardの前後で利用する | Performer Runtime | Performer RuntimeはVayriaとWildCardに依存しない汎用技術層 |
| `src/cards/wildcardDirection.ts` | show固有の演出 | card、effect、constraint、card lifecycle | WildCardのLive Direction | generic intentの後、resolverの前 | WildCard Live Direction | WildCard固有のcard演出をRuntimeへ提出する層 |
| HTTP header call sites | turn相関 | chat、TTS、eventを結ぶturn ID | generic transport contract | provider requestの全経路で利用する | `X-Performer-Turn-Id` | Performer Runtimeのturnを識別するHTTP header |
| env and localStorage call sites | 移行互換 | bind host、port、audio settings | Vayriaのローカル設定namespace | 新名を優先し、旧名をfallbackする | `VAYRIA_*`, `vayria.audio-settings.v1` | Vayria設定の正規名。旧WildCard名は互換用に残す |

## 2. Current inventory

The repository search found old project or show terms in 25 tracked files.

Generated `dist` output is ignored and is not a source of truth.
The current `public/avatar` asset path has no old project term.
The current repository has no hard-coded `github.com/wakadorimk2/wildcard` URL.
GitHub URLs in `package-lock.json` belong to dependency metadata.

### A. Rename to Vayria

- `package.json` and the two root `name` fields in `package-lock.json`.
- The project title and introduction in `README.md`.
- The HTML title in `index.html`.
- The non-exhibition project label in `src/App.tsx`.
- Project references in `THIRD_PARTY_NOTICES.md`.
- The source label and generic boundary wording in `docs/architecture/performer-runtime-terms.md`.
- The project tracking prefix in `docs/architecture/performer-runtime.md`.

The tracking IDs become:

- `WILD-PERFORMER-01` to `VAYRIA-PERFORMER-01`
- `WILD-PERFORMANCE-02` to `VAYRIA-PERFORMANCE-02`
- `WILD-DIRECTION-03` to `VAYRIA-DIRECTION-03`
- `WILD-WILDCARD-04` to `VAYRIA-WILDCARD-04`
- `WILD-AVATAR-05` to `VAYRIA-AVATAR-05`
- `WILD-EXHIBITION-06` to `VAYRIA-EXHIBITION-06`

### B. Keep WildCard

Keep the following show-specific names:

- `src/cards/wildcardDirection.ts`
- `src/cards/WildcardCard.tsx`
- `WildcardCardData`
- `wildcard-card` CSS classes and variables
- `wildcard-background-*` and `wildcard-forced-*`
- `directionId: 'wildcard'`
- `metadata: { origin: 'wildcard' }`
- `wildcard_assistant_response`
- `Wildcard cards` accessibility label
- WildCard Live Direction documentation
- WildCard card fixtures and exhibition stress-test labels

`wildcard_assistant_response` stays show-specific because its schema contains
card-specific `activatedCards`.

### C. Keep generic

Generic runtime-adjacent diagnostics use these names:

- `Performer emotion`
- `Performer VRM expressions`
- `Performer avatar`
- `performer:` performance marks
- `[performer-event]` structured logs
- `performer-local-api`
- `http://performer.invalid` URL parser sentinel

The files under `src/performer/` remain unchanged.
`Performer Core`, `Performer State`, `Performer Profile`,
`Performance Plan`, and `Performance Result` remain generic.

### D. Compatibility migration

#### Environment variables

Canonical names:

- `VAYRIA_BIND_HOST`
- `VAYRIA_PORT`

Legacy names remain accepted:

- `WILDCARD_BIND_HOST`
- `WILDCARD_PORT`

The canonical value wins when both names are set.
Existing ignored `.env.local` and `.env.exhibition` files are not rewritten.

#### localStorage

Canonical key:

- `vayria.audio-settings.v1`

Legacy key:

- `wildcard.audio-settings.v1`

The new key is read first.
The old key is read when the new key is absent or invalid.
The compatibility period writes both keys.
The schema and `.v1` suffix remain unchanged.

#### HTTP header

Canonical header:

- `X-Performer-Turn-Id`

Legacy header:

- `X-Wildcard-Turn-Id`

Bundled clients send the canonical header.
The local API accepts the canonical header first and the legacy header second.
The validation rule is unchanged.
Both headers are not emitted by bundled clients.

## 3. Repository rename impact

The GitHub repository is now:

```text
https://github.com/wakadorimk2/vayria
```

The default branch remains `main`.
Existing pull requests remain attached to the repository.
Existing branch names remain unchanged.
The local checkout directory remains `C:/Users/wakad/projects/wildcard`.

The old repository URL remains a compatibility redirect.
All local clones should update their `origin` URL to the new repository.

No repository workflow, hook, deployment, Actions secret, Actions variable,
environment, Pages site, ruleset, Cloudflare configuration, or `vayria.me`
reference was found in the repository.

Account-level GitHub Apps, Cloudflare account settings, and external log
consumers are outside the repository and require a separate read-only check.

## 4. Application structure after the rename

```text
Vayria
├─ Performer Runtime
│  ├─ Performer Core
│  ├─ State / Profile
│  ├─ Planning
│  └─ execution
├─ Character / Performer configuration
│  ├─ Vayria persona
│  ├─ voice
│  ├─ avatar
│  └─ performer defaults
└─ Shows
   └─ WildCard
      ├─ Live Direction
      ├─ cards
      ├─ exhibition UI
      └─ show-specific rules
```

The character configuration layer is a documented boundary only.
This rename does not add a Vayria persona implementation.
This rename does not reorganize the repository into a monorepo.

## 5. Exact implementation areas

Project metadata:

- `package.json`
- `package-lock.json`
- `README.md`
- `index.html`
- `src/App.tsx`
- `THIRD_PARTY_NOTICES.md`
- `docs/architecture/performer-runtime.md`
- `docs/architecture/performer-runtime-terms.md`

Compatibility and generic runtime:

- `.env.example`
- `.env.exhibition.example`
- `vite.config.ts`
- `src/App.tsx`
- `src/runtimeConfig.ts`
- `src/conversation/conversationEvents.ts`
- `src/conversation/useConversation.ts`
- `src/avatar/EmotionExpressionController.ts`
- `src/avatar/VrmStage.tsx`
- `server/localApi.ts`
- `scripts/stress-test.mjs`

## 6. Recommended execution order

1. Confirm a clean worktree, current HEAD, no open PR, and no extra worktree.
2. Rename the GitHub repository.
3. Update every local clone `origin` URL.
4. Apply project metadata and branding changes.
5. Apply generic runtime and compatibility changes.
6. Update architecture documentation and this plan.
7. Verify old-name occurrences by classification.
8. Run tests, lint, typecheck, build, and exhibition smoke tests.
9. Prepare `vayria.me` as a separate deployment task.

## 7. Verification checklist

Static checks:

- Search `wildcard`, `Wildcard`, `WILDCARD`, `Vayria`, and `VAYRIA`.
- Confirm every remaining old name is either WildCard show vocabulary or a
  documented compatibility fallback.
- Confirm `src/performer/` has no Vayria or WildCard dependency.
- Confirm no own old GitHub URL remains.
- Confirm `/api/chat`, `/api/tts`, and `/api/events` are unchanged.

Automated checks:

```text
npm test
npm run lint
npm run typecheck
npm run build
```

Runtime checks:

- Confirm the HTML title and local project label show `Vayria`.
- Confirm WildCard card labels, CSS classes, card insertion, and exhibition
  behavior remain unchanged.
- Confirm new and legacy env names both start the local server.
- Confirm canonical env names win over legacy names.
- Confirm new and legacy localStorage keys restore audio settings.
- Confirm canonical and legacy turn headers are accepted by the local API.
- Confirm the stress test sends the canonical header.

Repository checks:

- Confirm `origin` points to `wakadorimk2/vayria`.
- Confirm local HEAD and `origin/main` have the same SHA.
- Confirm old repository URLs redirect.
- Confirm pull request history and `main` remain available.

## 8. Rollback strategy

- Revert project metadata and compatibility changes by PR.
- Keep both localStorage keys during the compatibility period.
- Keep server support for both turn headers during the compatibility period.
- Keep legacy environment fallback.
- Do not create a replacement repository with the old name.
- If the repository rename causes an operational issue, temporarily use the
  old redirect URL while the cause is investigated.
- Do not change `vayria.me` or Cloudflare during this rename.

## 9. Things explicitly not changed

- WildCard card files, CSS classes, CSS variables, and direction IDs.
- `wildcard_assistant_response`.
- Performer Runtime types and architecture.
- API paths and JSON bodies.
- `public/avatar/model.vrm`.
- `.env.local` and `.env.exhibition`.
- Domain, DNS, Cloudflare, Pages, Workers, and deployment.
- Character, voice, avatar, and persona configuration implementation.
- Monorepo or directory restructuring.

## 10. Issue and PR split

1. Repository rename and local remote alignment.
2. Project metadata and branding rename.
3. Generic runtime and compatibility migration.
4. Architecture documentation and link cleanup.
5. `vayria.me` deployment preparation.

The fifth item remains a separate preparation task.
It does not perform a deployment as part of this rename.
