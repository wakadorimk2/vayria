import { readFile, appendFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPOSITORY = 'wakadorimk2/vayria';
export const LABEL = 'staging-preview';
export const WORKFLOW = 'staging-preview.yml';
export const CHECKS = ['CI', 'Python STT', 'Public checks'];
const shaPattern = /^[a-f0-9]{40}$/;

export function eligiblePr(pr) {
  return pr?.state === 'open' && !pr.merged && pr.base?.ref === 'main' &&
    pr.base?.repo?.full_name === REPOSITORY && pr.head?.repo?.full_name === REPOSITORY &&
    shaPattern.test(pr.head.sha) && pr.labels.some(label => label.name === LABEL);
}
export function successfulCi(run, jobs, sha, event) {
  return run?.path === '.github/workflows/ci.yml' && run.event === event && run.head_sha === sha &&
    run.head_repository?.full_name === REPOSITORY && run.status === 'completed' && run.conclusion === 'success' &&
    CHECKS.every(name => jobs.some(job => job.name === name && job.conclusion === 'success'));
}
export function currentSelection(pr, selection, mainSha, labelId) {
  return eligiblePr(pr) && pr.number === selection.pr && pr.head.sha === selection.sha &&
    selection.main === mainSha && selection.labelId === labelId;
}

export function github(token = process.env.GH_TOKEN, fetchImpl = fetch) {
  return async (path, method = 'GET', body) => {
    if (!token) throw new Error('GitHub token is required');
    const response = await fetchImpl(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
      method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error(`GitHub ${method} ${path.split('?')[0]} returned ${response.status}`);
    return response.status === 204 ? null : response.json();
  };
}
async function pages(api, path, field) {
  const result = [];
  for (let page = 1; page <= 100; page++) {
    const value = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = field ? value[field] : value;
    result.push(...items);
    if (items.length < 100) return result;
  }
  throw new Error('GitHub pagination limit exceeded');
}
async function labeled(api) {
  return (await pages(api, `issues?state=open&labels=${LABEL}`)).filter(issue => issue.pull_request);
}
async function labelEvent(api, number) {
  const events = await pages(api, `issues/${number}/events`);
  return events.filter(e => ['labeled', 'unlabeled'].includes(e.event) && e.label?.name === LABEL).at(-1);
}
async function ci(api, sha, event) {
  const runs = await pages(api, `actions/workflows/ci.yml/runs?head_sha=${sha}&event=${event}`, 'workflow_runs');
  const run = runs.sort((a, b) => b.id - a.id)[0];
  const jobs = run ? await pages(api, `actions/runs/${run.id}/jobs?filter=latest`, 'jobs') : [];
  return { run, ok: successfulCi(run, jobs, sha, event) };
}
async function mainState(api) {
  const main = (await api('git/ref/heads/main')).object.sha;
  const runs = await pages(api, `actions/workflows/ci.yml/runs?head_sha=${main}&branch=main`, 'workflow_runs');
  const run = runs.filter(r => ['push', 'workflow_dispatch'].includes(r.event)).sort((a, b) => b.id - a.id)[0];
  // Wait for the entire main pipeline, including production, before allowing a preview.
  return { main, ready: run?.status === 'completed' && run.conclusion === 'success', since: run?.created_at };
}
export async function clearSelection(api) {
  for (const issue of await labeled(api)) await api(`issues/${issue.number}/labels/${LABEL}`, 'DELETE');
}
export async function selectPreview(api, event, eventName) {
  if (!['workflow_dispatch', 'pull_request_target', 'workflow_run'].includes(eventName)) return null;
  const state = await mainState(api);
  if (eventName === 'workflow_dispatch') {
    if (!state.ready) return null;
    await clearSelection(api);
    return { pr: 0, sha: state.main, main: state.main, labelId: 0 };
  }
  // Removal/closure is enforced by the final guard; do not redeploy another PR as a side effect.
  if (eventName === 'pull_request_target' && (event.action !== 'labeled' || event.label?.name !== LABEL)) return null;
  const candidates = [];
  for (const issue of await labeled(api)) {
    const pr = await api(`pulls/${issue.number}`);
    const selection = await labelEvent(api, issue.number);
    const permission = selection?.actor?.login ? await api(`collaborators/${encodeURIComponent(selection.actor.login)}/permission`) : null;
    if (!eligiblePr(pr) || selection?.event !== 'labeled' || !['admin', 'maintain', 'write'].includes(permission?.permission) ||
        !state.ready || !state.since || selection.created_at <= state.since) {
      await api(`issues/${issue.number}/labels/${LABEL}`, 'DELETE');
      continue;
    }
    candidates.push({ pr, selection });
  }
  candidates.sort((a, b) => b.selection.id - a.selection.id);
  const selected = candidates[0];
  for (const other of candidates.slice(1)) await api(`issues/${other.pr.number}/labels/${LABEL}`, 'DELETE');
  if (!selected) return null;
  if (eventName === 'workflow_run' && event.workflow_run?.head_sha !== selected.pr.head.sha) return null;
  if (!(await ci(api, selected.pr.head.sha, 'pull_request')).ok) return null;
  return { pr: selected.pr.number, sha: selected.pr.head.sha, main: state.main, labelId: selected.selection.id };
}
export async function verifySelection(api, selection) {
  if (!shaPattern.test(selection.sha) || !shaPattern.test(selection.main) || !Number.isSafeInteger(selection.pr) || selection.pr < 0)
    throw new Error('Invalid selection');
  const state = await mainState(api);
  if (!state.ready || state.main !== selection.main) throw new Error('Main changed or its CD is active');
  if (selection.pr === 0) {
    if (selection.sha !== state.main || (await labeled(api)).length) throw new Error('Main restore superseded');
    return;
  }
  const labels = await labeled(api);
  const pr = await api(`pulls/${selection.pr}`);
  const event = await labelEvent(api, selection.pr);
  if (labels.length !== 1 || labels[0].number !== selection.pr || event?.event !== 'labeled' ||
      !currentSelection(pr, selection, state.main, event.id) || !(await ci(api, selection.sha, 'pull_request')).ok)
    throw new Error('Preview selection or CI changed');
}
export async function drainPreviews(api, sleep = ms => new Promise(done => setTimeout(done, ms))) {
  // This gate runs in main CD. Preview jobs reject main while this CI run is active.
  await clearSelection(api);
  for (let attempt = 0; attempt < 90; attempt++) {
    const runs = await pages(api, `actions/workflows/${WORKFLOW}/runs`, 'workflow_runs');
    if (!runs.some(run => run.status !== 'completed')) return;
    await sleep(10000);
  }
  throw new Error('Preview still running; main deployment stopped without overwriting it');
}
async function cli() {
  const api = github();
  const action = process.argv[2];
  if (action === 'main-reset') return clearSelection(api);
  if (action === 'main-wait') return drainPreviews(api);
  if (action === 'select') {
    const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
    const selected = await selectPreview(api, event, process.env.GITHUB_EVENT_NAME);
    if (selected) {
      await writeFile('selection.json', JSON.stringify(selected));
      await appendFile(process.env.GITHUB_OUTPUT, `selected=true\nsha=${selected.sha}\nmain=${selected.main}\npr=${selected.pr}\nlabelId=${selected.labelId}\n`);
      if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY,
        `Selected staging build\n\nPR: ${selected.pr || 'main'}\nCommit: ${selected.sha}\nControl revision: ${selected.main}\nURL: https://staging.vayria.me\n`);
    } else await appendFile(process.env.GITHUB_OUTPUT, 'selected=false\n');
    return;
  }
  throw new Error('Unknown preview action');
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) cli().catch(error => { console.error(error.message); process.exitCode = 1; });
