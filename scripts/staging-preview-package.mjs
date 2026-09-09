import { readdir, lstat, readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';
import { validateVrm, validateTarget, validateBuildBase, STAGING_URL, runCd } from './public-cd.mjs';
import { github, verifySelection, REPOSITORY } from './staging-preview.mjs';

export async function files(root) {
  const result = [];
  let bytes = 0;
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) throw new Error('Links are not allowed in deployment artifacts');
    if (stat.isDirectory()) {
      for (const name of await readdir(path)) {
        if (/[\x00-\x1f\\/:*?"<>|]/.test(name) || name === '.' || name === '..') throw new Error('Unsafe artifact filename');
        await visit(join(path, name));
      }
    } else {
      if (!stat.isFile()) throw new Error('Only regular artifact files are allowed');
      bytes += stat.size;
      if (bytes > 100 * 1024 * 1024 || result.length >= 10000) throw new Error('Artifact is too large');
      result.push(relative(root, path).replaceAll('\\', '/'));
    }
  }
  await visit(root);
  return result;
}
export async function validatePackage(root, pinned) {
  const entries = await files(root);
  if (!entries.includes('worker/index.js') || !entries.includes('assets/index.html')) throw new Error('Incomplete preview package');
  if (entries.some(name => !name.startsWith('assets/') && name !== 'worker/index.js'))
    throw new Error('Unexpected preview package file');
  validateWorker(await readFile(join(root, 'worker/index.js'), 'utf8'));
  validateBuildBase(await readFile(join(root, 'assets/index.html'), 'utf8'), 'staging');
  await validateVrm(await readFile(join(root, 'assets/avatar/model.vrm')), pinned);
}
export function validateWorker(code) {
  if (Buffer.byteLength(code) > 10 * 1024 * 1024) throw new Error('Worker bundle is too large');
  const tree = ts.createSourceFile('index.js', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  if (tree.parseDiagnostics.length) throw new Error('Invalid Worker JavaScript');
  const check = node => {
    if (!node || !ts.isStringLiteral(node) || !/^(node:[a-z_/]+|cloudflare:workers)$/.test(node.text))
      throw new Error('Worker must be self-contained; filesystem and computed imports are forbidden');
  };
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node) && node.moduleSpecifier) check(node.moduleSpecifier);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) check(node.arguments[0]);
    ts.forEachChild(node, visit);
  };
  visit(tree);
}
export function previewConfig(config, root) {
  validateTarget(config);
  const result = structuredClone(config);
  result.main = resolve(root, 'worker/index.js');
  result.assets.directory = resolve(root, 'assets');
  delete result.build;
  result.no_bundle = true;
  result.upload_source_maps = false;
  result.find_additional_modules = false;
  result.rules = [];
  return result;
}
function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0 || result.error) throw new Error('Preview packaging/deployment command failed');
  return result.stdout;
}
export async function pack(source, destination, control = process.cwd()) {
  const bundle = resolve(source, '.wrangler/preview-bundle');
  run(process.execPath, [resolve(control, 'node_modules/wrangler/wrangler-dist/cli.js'), 'deploy', '--dry-run',
    '--config', 'wrangler.public.jsonc', '--env-file', 'deploy/placeholder.env', '--outdir', bundle], source);
  await mkdir(join(destination, 'worker'), { recursive: true });
  for (const name of await files(bundle)) {
    if (/^[A-Za-z0-9_.-]+\.(js|wasm)$/.test(name)) await copyFile(join(bundle, name), join(destination, 'worker', name));
  }
  const assets = join(source, 'dist-public');
  for (const name of await files(assets)) {
    const target = join(destination, 'assets', name);
    await mkdir(resolve(target, '..'), { recursive: true });
    await copyFile(join(assets, name), target);
  }
}
export async function deployPackage(root, selection, api = github()) {
  const config = JSON.parse(await readFile('wrangler.public.jsonc', 'utf8'));
  validateTarget(config);
  const pinned = JSON.parse(await readFile('deploy/public-vrm.json', 'utf8'));
  // The unprivileged build uses a fixture. Never upload the private VRM as an Actions artifact.
  await files(root);
  const avatar = await readFile('.wrangler/public-vrm/model.vrm');
  validateVrm(avatar, pinned);
  await writeFile(join(root, 'assets/avatar/model.vrm'), avatar);
  await validatePackage(root, pinned);
  await verifySelection(api, selection);
  // This config and CLI come from main, never from the PR artifact. No build hook executes here.
  await mkdir('.wrangler', { recursive: true });
  const path = resolve('.wrangler/preview-deploy.json');
  await writeFile(path, JSON.stringify(previewConfig(config, root)));
  const logUrl = `https://github.com/${REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`;
  const deployment = await api('deployments', 'POST', { ref: selection.sha, environment: 'staging',
    auto_merge: false, required_contexts: [], transient_environment: true, production_environment: false,
    description: selection.pr ? `PR #${selection.pr} preview` : 'Restore latest main', payload: selection });
  let version;
  const status = (state, description) => api(`deployments/${deployment.id}/statuses`, 'POST', {
    state, description, environment_url: STAGING_URL, log_url: logUrl, auto_inactive: state === 'success',
  });
  try {
    await status('in_progress', `Commit ${selection.sha}`);
    await verifySelection(api, selection);
    const output = run(process.execPath, ['node_modules/wrangler/wrangler-dist/cli.js', 'deploy', '--no-bundle',
      '--config', path, '--env-file', 'deploy/placeholder.env'], process.cwd());
    version = output.match(/Current Version ID:\s*([a-f0-9-]{36})/i)?.[1];
    if (!version) throw new Error('Worker Version missing; inspect Cloudflare before retrying');
    const summary = `Staging preview\n\nPR: ${selection.pr || 'main'}\nCommit: ${selection.sha}\nWorker Version: ${version}\nURL: ${STAGING_URL}\n`;
    console.log(summary);
    if (process.env.GITHUB_STEP_SUMMARY) await (await import('node:fs/promises')).appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
    await runCd('smoke', 'staging');
    await status('success', `Version ${version}`);
  } catch (error) {
    await status('failure', version ? `Smoke failed; version ${version} may be live` : `Failed for ${selection.sha}; inspect run before retrying`);
    throw error;
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2];
  const task = action === 'pack' ? pack(resolve(process.argv[3]), resolve(process.argv[4])) :
    action === 'deploy' ? deployPackage(resolve(process.argv[3]), JSON.parse(process.env.PREVIEW_SELECTION)) : Promise.reject(new Error('Unknown package action'));
  task.catch(error => { console.error(error.message); process.exitCode = 1; });
}
