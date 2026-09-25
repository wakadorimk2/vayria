#!/usr/bin/env node
// Headless sweep for the Stream VLM benchmark endpoint.
// Requires a running dev server with VAYRIA_STREAM_BENCH=true.
// Usage: node scripts/run-stream-vlm-bench.mjs [--port 5189] [--providers openai-nano,groq-vision] [--reps 2] [--out path]
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
function argValue(name, fallback) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : fallback;
}

const port = Number(argValue('port', process.env.VAYRIA_PORT ?? 5187));
const reps = Math.max(1, Math.round(Number(argValue('reps', '2')) || 1));
const providerFilter = argValue('providers', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const fixtureFilter = argValue('fixtures', '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const outPath = argValue(
  'out',
  `stream-bench/results/stream-vlm-bench-${Date.now()}.json`,
);
const baseUrl = `http://127.0.0.1:${port}`;
const benchPath = '/api/stream/vlm-bench';

function percentile(values, rank) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((rank / 100) * sorted.length) - 1),
  );
  return sorted[index];
}

async function getJson(path) {
  const response = await fetch(`${baseUrl}${path}`);
  if (!response.ok) {
    throw new Error(`GET ${path} failed with HTTP ${response.status}`);
  }
  return response.json();
}

const { fixtures } = await getJson(`${benchPath}/fixtures`);
const { providers } = await getJson(`${benchPath}/providers`);
const selectedProviders = providers.filter(
  (provider) =>
    provider.configured &&
    (providerFilter.length === 0 || providerFilter.includes(provider.id)),
);
const selectedFixtures = fixtures.filter(
  (fixture) =>
    fixtureFilter.length === 0 || fixtureFilter.includes(fixture.id),
);
if (selectedProviders.length === 0) {
  console.error('No configured providers selected. Set provider API keys and retry.');
  process.exit(1);
}
if (selectedFixtures.length === 0) {
  console.error('No fixtures found. Add frame pairs under stream-bench/fixtures/<id>/.');
  process.exit(1);
}
const total = selectedProviders.length * selectedFixtures.length * reps;
console.log(
  `Sweep: ${selectedProviders.length} provider(s) x ${selectedFixtures.length} fixture(s) x ${reps} rep(s) = ${total} requests`,
);

const results = [];
let completed = 0;
for (const provider of selectedProviders) {
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const fixture of selectedFixtures) {
      const response = await fetch(`${baseUrl}${benchPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fixtureId: fixture.id, providerId: provider.id }),
      });
      if (response.ok) {
        results.push(await response.json());
      } else {
        const body = await response.json().catch(() => null);
        results.push({
          fixtureId: fixture.id,
          providerId: provider.id,
          model: provider.model,
          ok: false,
          jsonOk: false,
          parseOk: false,
          latencyMs: 0,
          observation: null,
          error: {
            kind: 'http',
            message: body?.error ?? `HTTP ${response.status}`,
            status: response.status,
          },
        });
      }
      completed += 1;
      process.stdout.write(`\r${completed}/${total} ${provider.id} ${fixture.id}          `);
    }
  }
}
process.stdout.write('\n');

const summaries = selectedProviders.map((provider) => {
  const scored = results.filter((result) => result.providerId === provider.id);
  const latencies = scored.filter((r) => r.jsonOk).map((r) => r.latencyMs);
  const inputTokens = scored.reduce((t, r) => t + (r.usage?.inputTokens ?? 0), 0);
  const outputTokens = scored.reduce((t, r) => t + (r.usage?.outputTokens ?? 0), 0);
  const changedScored = scored.filter(
    (r) => r.expected?.changed !== null && r.expected !== undefined,
  );
  const changedCorrect = changedScored.filter(
    (r) => r.observation && r.observation.changed === r.expected.changed,
  );
  const eventScored = scored.filter((r) => (r.expected?.eventKinds ?? []).length > 0);
  const eventHit = eventScored.filter((r) =>
    r.observation?.events.some((event) => r.expected.eventKinds.includes(event.kind)),
  );
  const usageKnown = scored.some(
    (r) => r.usage?.inputTokens != null || r.usage?.outputTokens != null,
  );
  const price = provider.usdPerMillionTokens;
  return {
    providerId: provider.id,
    model: scored[0]?.model ?? provider.model,
    sampleCount: scored.length,
    errorCount: scored.filter((r) => r.error !== undefined).length,
    jsonOkCount: scored.filter((r) => r.jsonOk).length,
    parseOkCount: scored.filter((r) => r.parseOk).length,
    changedScoreCount: changedScored.length,
    changedCorrectCount: changedCorrect.length,
    eventScoreCount: eventScored.length,
    eventHitCount: eventHit.length,
    latencyP50Ms: percentile(latencies, 50),
    latencyP95Ms: percentile(latencies, 95),
    inputTokens,
    outputTokens,
    estimatedCostUsd: usageKnown
      ? (inputTokens / 1e6) * price.input + (outputTokens / 1e6) * price.output
      : null,
  };
});

for (const summary of summaries) {
  console.log(
    `${summary.providerId} (${summary.model})` +
      ` | n=${summary.sampleCount} errors=${summary.errorCount}` +
      ` | json=${summary.jsonOkCount} schema=${summary.parseOkCount}` +
      ` | changed=${summary.changedCorrectCount}/${summary.changedScoreCount}` +
      ` | events=${summary.eventHitCount}/${summary.eventScoreCount}` +
      ` | p50=${summary.latencyP50Ms}ms p95=${summary.latencyP95Ms}ms` +
      ` | est=${summary.estimatedCostUsd === null ? 'n/a' : '$' + summary.estimatedCostUsd.toFixed(4)}`,
  );
}

const resolvedOut = resolve(outPath);
mkdirSync(resolve(resolvedOut, '..'), { recursive: true });
writeFileSync(
  resolvedOut,
  JSON.stringify(
    {
      schemaVersion: 1,
      completedAt: new Date().toISOString(),
      baseUrl,
      reps,
      results,
      summaries,
    },
    null,
    2,
  ),
);
console.log(`Report written to ${resolvedOut}`);
