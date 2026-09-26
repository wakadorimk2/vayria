#!/usr/bin/env node
// Draft-labels stream fixtures with a vision model so a human only has to
// review and correct them. Use a model that is NOT a benchmark candidate
// (default: gpt-5-mini) to avoid measuring a provider against its own labels.
//
// Usage (API key via 1Password):
//   pwsh -NoProfile -File scripts/Start-VayriaWithOnePassword.ps1 `
//     -CommandPath node -CommandArguments "scripts/label-stream-fixtures.mjs"
// Options: --model <name> --limit <n> --concurrency <n> --force --dry-run

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const worktreeRoot = resolve(import.meta.dirname, '..');
const fixturesRoot = join(worktreeRoot, 'stream-bench', 'fixtures');
const bundleDir = join(worktreeRoot, 'stream-bench', '.work', 'label-bundle');

function parseArgs() {
  const args = {
    model: 'gpt-5-mini',
    limit: 0,
    concurrency: 3,
    force: false,
    dryRun: false,
  };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--model') args.model = argv[++i];
    else if (argv[i] === '--limit') args.limit = Number(argv[++i]);
    else if (argv[i] === '--concurrency') args.concurrency = Number(argv[++i]);
    else if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--dry-run') args.dryRun = true;
  }
  return args;
}

// Reuse the server-side provider + game profile modules by bundling them
// once with esbuild (already a devDependency).
async function buildProviderBundle() {
  mkdirSync(bundleDir, { recursive: true });
  await build({
    entryPoints: [
      'server/stream/visionProviders.ts',
      'server/stream/gameProfiles.ts',
      'server/stream/contactSheet.ts',
    ],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'node',
    // sharp ships native binaries with dynamic requires — never bundle it.
    external: ['sharp'],
    absWorkingDir: worktreeRoot,
    outdir: bundleDir,
    outExtension: { '.js': '.mjs' },
    logLevel: 'error',
  });
}

function listFixtureIds() {
  return readdirSync(fixturesRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((id) => existsSync(join(fixturesRoot, id, 'meta.json')))
    .sort();
}

function readMeta(dir) {
  return JSON.parse(readFileSync(join(dir, 'meta.json'), 'utf8'));
}

const FRAME_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'webp']);

function framePath(dir, baseName) {
  for (const entry of readdirSync(dir)) {
    const dot = entry.lastIndexOf('.');
    if (
      entry.slice(0, dot) === baseName &&
      FRAME_EXTENSIONS.has(entry.slice(dot + 1).toLowerCase())
    ) {
      return join(dir, entry);
    }
  }
  return null;
}

function midFramePaths(dir) {
  return readdirSync(dir)
    .filter((name) => {
      const dot = name.lastIndexOf('.');
      return (
        /^mid-\d+$/.test(name.slice(0, dot)) &&
        FRAME_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
      );
    })
    .sort(
      (a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]),
    )
    .map((name) => join(dir, name));
}

// The VLM payload is one labeled contact-sheet image. Extracted fixtures
// ship contact-sheet.jpg; hand-made fixtures get one composed on the fly.
async function sheetImage(fixture, buildSheet) {
  const sheetPath = framePath(fixture.dir, 'contact-sheet');
  if (sheetPath) return readFileSync(sheetPath);
  const framePaths = [
    framePath(fixture.dir, 'before'),
    ...midFramePaths(fixture.dir),
    framePath(fixture.dir, 'after'),
  ].filter(Boolean);
  const windowSec = fixture.meta.source?.windowSec;
  const spacingSec =
    typeof windowSec === 'number' && framePaths.length > 0
      ? windowSec / framePaths.length
      : null;
  return buildSheet(
    framePaths.map((path, index) => ({
      path,
      label:
        spacingSec === null
          ? `F${index + 1}`
          : `F${index + 1}  ${(index * spacingSec).toFixed(1)}s`,
    })),
  );
}

function summarizeObservation(observation) {
  const parts = [observation.changeSummary?.trim()].filter(Boolean);
  if (observation.player?.activity) {
    parts.push(`activity: ${observation.player.activity}`);
  }
  if (observation.scene?.bloodMoon) parts.push('blood moon');
  if (observation.player?.healthState === 'dead') parts.push('player dead');
  return parts.join(' | ');
}

async function main() {
  const args = parseArgs();
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      'OPENAI_API_KEY is not set. Run through scripts/Start-VayriaWithOnePassword.ps1.',
    );
  }
  await buildProviderBundle();
  const { STREAM_VISION_PROVIDERS } = await import(
    pathToFileURL(join(bundleDir, 'visionProviders.mjs')).href
  );
  const { resolveGameProfile, streamObservationSchema } = await import(
    pathToFileURL(join(bundleDir, 'gameProfiles.mjs')).href
  );
  const { buildContactSheet } = await import(
    pathToFileURL(join(bundleDir, 'contactSheet.mjs')).href
  );

  const provider = STREAM_VISION_PROVIDERS.find((p) => p.id === 'openai-nano');
  if (!provider) throw new Error('openai-nano provider not found in bundle.');
  const profile = resolveGameProfile('7dtd');
  const instruction = profile.buildObservationInstruction();
  const schema = streamObservationSchema(profile);

  const fixtures = listFixtureIds()
    .map((id) => ({ id, dir: join(fixturesRoot, id) }))
    .map((fixture) => ({ ...fixture, meta: readMeta(fixture.dir) }))
    .filter((fixture) => args.force || fixture.meta.expectedChanged === null)
    .slice(0, args.limit > 0 ? args.limit : undefined);

  console.log(
    `Labeling ${fixtures.length} fixtures with ${args.model} (concurrency ${args.concurrency})`,
  );

  let cursor = 0;
  let labeled = 0;
  let failed = 0;
  const worker = async () => {
    while (cursor < fixtures.length) {
      const fixture = fixtures[cursor];
      cursor += 1;
      try {
        const image = await sheetImage(fixture, buildContactSheet);
        const result = await provider.observe(
          {
            instruction,
            schema,
            image,
            model: args.model,
          },
          process.env.OPENAI_API_KEY,
        );
        const observation = JSON.parse(result.rawText);
        if (!args.dryRun) {
          const meta = fixture.meta;
          meta.expectedChanged = Boolean(observation.changed);
          meta.expectedEventKinds = (observation.events ?? [])
            .map((event) => event.kind)
            .filter((kind) => typeof kind === 'string');
          meta.category =
            meta.expectedEventKinds[0] ??
            (meta.expectedChanged ? 'other' : 'static');
          meta.notes = summarizeObservation(observation);
          meta.labelDraft = {
            model: result.model,
            labeledAt: new Date().toISOString(),
            reviewed: false,
          };
          writeFileSync(
            join(fixture.dir, 'meta.json'),
            `${JSON.stringify(meta, null, 2)}\n`,
          );
        }
        labeled += 1;
        process.stdout.write(
          `\r${labeled} labeled, ${failed} failed (${fixture.id})   `,
        );
      } catch (error) {
        failed += 1;
        console.warn(`\n${fixture.id}: ${error.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: args.concurrency }, worker));
  console.log(`\nDone: ${labeled} labeled, ${failed} failed.`);
}

await main();
