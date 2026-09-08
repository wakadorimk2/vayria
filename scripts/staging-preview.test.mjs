import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { load } from 'js-yaml';
import { eligiblePr, successfulCi, currentSelection, selectPreview, verifySelection, drainPreviews, REPOSITORY, LABEL, CHECKS } from './staging-preview.mjs';
import { validatePackage, validateWorker, previewConfig } from './staging-preview-package.mjs';

const main = 'a'.repeat(40), sha = 'b'.repeat(40), other = 'c'.repeat(40);
const pr = (number = 101) => ({ number, state: 'open', merged: false, labels: [{ name: LABEL }],
  base: { ref: 'main', repo: { full_name: REPOSITORY } }, head: { sha, repo: { full_name: REPOSITORY } } });
const run = (sha, event = 'pull_request') => ({ id: 20, path: '.github/workflows/ci.yml', event, head_sha: sha,
  head_repository: { full_name: REPOSITORY }, status: 'completed', conclusion: 'success', created_at: '2026-09-09T00:00:00Z' });
const jobs = () => CHECKS.map(name => ({ name, conclusion: 'success' }));
function mock() {
  const state = { main, mainReady: true, ci: true, prs: [pr()], labelId: 5, actor: 'write', drains: 0, changes: [], ciJobs: jobs() };
  const api = async (path, method = 'GET') => {
    if (method === 'DELETE') { const n = Number(path.split('/')[1]); state.changes.push(n); state.prs = state.prs.filter(p => p.number !== n); return null; }
    if (path === 'git/ref/heads/main') return { object: { sha: state.main } };
    if (path.startsWith('issues?')) return state.prs.map(p => ({ number: p.number, pull_request: {} }));
    if (/^pulls\//.test(path)) return structuredClone(state.prs.find(p => p.number === Number(path.split('/')[1])) ?? { ...pr(), state: 'closed' });
    if (/issues\/\d+\/events/.test(path)) return [{ id: state.labelId + (Number(path.split('/')[1]) - 101), event: 'labeled', label: { name: LABEL }, created_at: '2026-09-09T01:00:00Z', actor: { login: 'owner' } }];
    if (path.startsWith('collaborators/')) return { permission: state.actor };
    if (path.startsWith('actions/workflows/staging-preview.yml')) { state.drains++; return { workflow_runs: state.drains < 3 ? [{ status: 'in_progress' }] : [] }; }
    if (path.startsWith('actions/workflows/ci.yml')) {
      if (path.includes('branch=main')) return { workflow_runs: [{ ...run(state.main, 'push'), status: state.mainReady ? 'completed' : 'in_progress', conclusion: state.mainReady ? 'success' : null }] };
      return { workflow_runs: [{ ...run(sha), conclusion: state.ci ? 'success' : 'failure' }] };
    }
    if (path.startsWith('actions/runs/20/jobs')) return { jobs: state.ciJobs };
    throw new Error(`Unexpected API: ${method} ${path}`);
  };
  return { state, api };
}

test('selection requires same-repository open PR and exact successful CI with all jobs', () => {
  assert.ok(eligiblePr(pr()));
  for (const change of [{ state: 'closed' }, { merged: true }, { labels: [] }, { head: { sha, repo: { full_name: 'fork/repo' } } }, { base: { ref: 'dev', repo: { full_name: REPOSITORY } } }]) assert.equal(eligiblePr({ ...pr(), ...change }), false);
  assert.ok(successfulCi(run(sha), jobs(), sha, 'pull_request'));
  for (const change of [{ status: 'in_progress' }, { conclusion: 'failure' }, { head_sha: other }, { path: '.github/workflows/fake.yml' }, { event: 'push' }]) assert.equal(successfulCi({ ...run(sha), ...change }, jobs(), sha, 'pull_request'), false);
  assert.equal(successfulCi(run(sha), jobs().slice(1), sha, 'pull_request'), false);
});
test('latest selection wins; CI updates only deploy the exact selected head', async () => {
  const { state, api } = mock(); state.prs.push(pr(102));
  const value = await selectPreview(api, { action: 'labeled', label: { name: LABEL } }, 'pull_request_target');
  assert.deepEqual(value, { pr: 102, sha, main, labelId: 6 }); assert.deepEqual(state.changes, [101]);
  assert.equal(await selectPreview(api, { workflow_run: { head_sha: other } }, 'workflow_run'), null);
  assert.ok(await selectPreview(api, { workflow_run: { head_sha: sha } }, 'workflow_run'));
  state.ci = false; assert.equal(await selectPreview(api, { action: 'labeled', label: { name: LABEL } }, 'pull_request_target'), null);
});
test('untrusted label actor, external fork and active main revoke selection', async () => {
  for (const mutate of [s => { s.actor = 'triage'; }, s => { s.mainReady = false; }, s => { s.prs[0].head.repo.full_name = 'fork/repo'; }]) {
    const { state, api } = mock(); mutate(state);
    assert.equal(await selectPreview(api, { action: 'labeled', label: { name: LABEL } }, 'pull_request_target'), null);
    assert.deepEqual(state.changes, [101]);
  }
});
test('final guard rejects unlabel, close, new head, main update, new label epoch and failed jobs', async () => {
  const selection = { pr: 101, sha, main, labelId: 5 };
  await verifySelection(mock().api, selection);
  for (const mutate of [s => { s.prs = []; }, s => { s.prs[0].state = 'closed'; }, s => { s.prs[0].head.sha = other; }, s => { s.main = other; }, s => { s.labelId++; }, s => { s.ciJobs[0].conclusion = 'failure'; }, s => { s.mainReady = false; }]) {
    const { state, api } = mock(); mutate(state); await assert.rejects(verifySelection(api, selection));
  }
  assert.equal(currentSelection(pr(), selection, other, 5), false);
});
test('manual main restore clears selection and has no production action', async () => {
  const { state, api } = mock();
  const selection = await selectPreview(api, {}, 'workflow_dispatch');
  assert.deepEqual(selection, { pr: 0, sha: main, main, labelId: 0 });
  await verifySelection(api, selection); assert.deepEqual(state.changes, [101]);
  state.prs.push(pr()); await assert.rejects(verifySelection(api, selection));
});
test('main clears labels and waits for existing preview runs without cancelling upload', async () => {
  const { state, api } = mock(); let waits = 0;
  await drainPreviews(api, async () => { waits++; });
  assert.deepEqual(state.changes, [101]); assert.equal(waits, 2);
});
test('closing or removing a label never starts a fallback preview', async () => {
  for (const action of ['closed', 'unlabeled']) {
    const { state, api } = mock();
    assert.equal(await selectPreview(api, { action, label: { name: LABEL } }, 'pull_request_target'), null);
    assert.deepEqual(state.changes, []);
  }
});
test('main wait times out instead of racing a still-running preview', async () => {
  const { api } = mock(); let waits = 0;
  await assert.rejects(drainPreviews(async (path, ...args) => path.startsWith('actions/workflows/staging-preview.yml') ?
    { workflow_runs: [{ status: 'in_progress' }] } : api(path, ...args), async () => { waits++; }));
  assert.equal(waits, 90);
});
test('preview config fixes the staging target and disables build hooks and module discovery', async () => {
  const staging = JSON.parse(await readFile('wrangler.public.jsonc', 'utf8'));
  const result = previewConfig({ ...staging, build: { command: 'must not execute' } }, 'incoming');
  assert.equal(result.build, undefined); assert.equal(result.no_bundle, true); assert.equal(result.find_additional_modules, false);
  assert.deepEqual(result.routes, staging.routes); assert.deepEqual(result.durable_objects, staging.durable_objects);
  assert.throws(() => previewConfig({ ...staging, name: 'vayria-web' }, 'incoming'));
});
test('Worker package cannot read runner files through imports or execute build config', async () => {
  validateWorker('import { DurableObject } from "cloudflare:workers"; export default {};');
  for (const code of ['import "../../secret.js";', 'export * from "file:///secret";', 'import(process.env.PATH);', 'import("./secret.js");', 'const = ;']) assert.throws(() => validateWorker(code));
  const root = await mkdtemp(join(tmpdir(), 'vayria-preview-test-'));
  const avatar = Buffer.from('pinned test avatar');
  const pinned = { bytes: avatar.length, sha256: createHash('sha256').update(avatar).digest('hex') };
  try {
    await mkdir(join(root, 'worker')); await mkdir(join(root, 'assets/avatar'), { recursive: true });
    await writeFile(join(root, 'worker/index.js'), 'export default {};');
    await writeFile(join(root, 'assets/index.html'), '<div id="root"></div>');
    await writeFile(join(root, 'assets/avatar/model.vrm'), avatar);
    await validatePackage(root, pinned);
    await writeFile(join(root, 'wrangler.json'), '{"build":{"command":"malicious"}}');
    await assert.rejects(validatePackage(root, pinned));
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('workflow separates PR execution from write tokens and deploy credentials; main drains previews', async () => {
  const workflow = load(await readFile('.github/workflows/staging-preview.yml', 'utf8'));
  assert.deepEqual(workflow.permissions, {});
  assert.deepEqual(workflow.jobs.build.permissions, { contents: 'read' });
  assert.doesNotMatch(JSON.stringify(workflow.jobs.build), /secrets\.|GH_TOKEN|environment|cache:/);
  assert.equal(workflow.jobs.deploy.environment.name, 'staging');
  assert.ok(workflow.jobs.deploy.steps.filter(s => s.uses?.startsWith('actions/checkout')).every(s => s.with.ref === '${{ needs.select.outputs.main }}'));
  assert.doesNotMatch(JSON.stringify(workflow), /production-cd|wrangler.production|Deploy production/);
  assert.ok(workflow.jobs.deploy.steps.some(s => s.run === 'npm ci --ignore-scripts'));
  const ci = load(await readFile('.github/workflows/ci.yml', 'utf8'));
  assert.ok(ci.jobs['deploy-staging'].needs.includes('preview-reset'));
  const steps = ci.jobs['deploy-staging'].steps;
  assert.ok(steps.findIndex(s => s.run?.includes('main-wait')) < steps.findIndex(s => s.run === 'node scripts/staging-cd.mjs deploy'));
  assert.notEqual(workflow.concurrency.group, ci.jobs['deploy-staging'].concurrency.group);
});
