import assert from 'node:assert/strict';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ProjectDocumentError,
  createProjectViewServer,
  generateProjectView,
  parseProjectMarkdown,
  renderProjectHtml,
} from './project-view.mjs';

const VALID_PROJECT = `# Vayria Mission Control

- Target: 2026-09-23 Exhibition
- Reviewed: 2026-09-01
- Phase: 2/5 展示品質

## Phases

- 実環境
- 展示品質
- 候補版・Soft Freeze
- Go/No-Go・Hard Freeze
- 展示

## Now

- [Issue #21](https://github.com/example/vayria/issues/21) の証拠を確認する
- Fish & Chips と 1 < 2 を安全に表示する

## Next

- [Issue #29](https://github.com/example/vayria/issues/29) を確認する

## Recently Done

- [PR #74](https://github.com/example/vayria/pull/74) をmergeした
`;

test('parser reads the required five-phase project document', () => {
  const project = parseProjectMarkdown(VALID_PROJECT);

  assert.equal(project.title, 'Vayria Mission Control');
  assert.equal(project.targetDate, '2026-09-23');
  assert.equal(project.targetLabel, 'Exhibition');
  assert.equal(project.reviewed, '2026-09-01');
  assert.equal(project.phaseCurrent, 2);
  assert.equal(project.phaseTotal, 5);
  assert.equal(project.phaseLabel, '展示品質');
  assert.deepEqual(project.phases, [
    '実環境',
    '展示品質',
    '候補版・Soft Freeze',
    'Go/No-Go・Hard Freeze',
    '展示',
  ]);
  assert.equal(project.now.length, 2);
  assert.equal(project.next.length, 1);
  assert.equal(project.recentlyDone.length, 1);
});

test('parser rejects missing sections, mismatched phases, raw HTML, and unsafe links', () => {
  assert.throws(
    () => parseProjectMarkdown(VALID_PROJECT.replace('## Next', '## Later')),
    (error) => error instanceof ProjectDocumentError && /Unknown section: Later/.test(error.message),
  );
  assert.throws(
    () => parseProjectMarkdown(VALID_PROJECT.replace('2/5 展示品質', '6/5 展示品質')),
    /Current phase is outside the phase range/,
  );
  assert.throws(
    () => parseProjectMarkdown(VALID_PROJECT.replace('Fish & Chips', '<script>alert(1)<\/script>')),
    /Raw HTML is not allowed/,
  );
  assert.throws(
    () => parseProjectMarkdown(VALID_PROJECT.replace('https://github.com/example/vayria/issues/21', 'javascript:alert(1)')),
    /Link protocol must be http or https/,
  );
});

test('generator emits semantic regions, current phase state, safe text, and safe links', async () => {
  const project = parseProjectMarkdown(VALID_PROJECT);
  const html = renderProjectHtml(project, { liveReload: true });

  assert.match(html, /<h2 id="now-heading">NOW<\/h2>/);
  assert.match(html, /<h2 id="next-heading">NEXT<\/h2>/);
  assert.match(html, /<h2 id="done-heading">RECENTLY DONE<\/h2>/);
  assert.match(html, /aria-current="step"/);
  assert.match(html, />現在<\/span>/);
  assert.match(html, /target="_blank" rel="noopener noreferrer"/);
  assert.match(html, /Fish &amp; Chips と 1 &lt; 2/);
  assert.match(html, /prefers-color-scheme: dark/);
  assert.match(html, /prefers-reduced-motion: reduce/);
  assert.match(html, /new EventSource\('\/events'\)/);

  const root = await mkdtemp(join(tmpdir(), 'vayria-project-view-generate-'));
  try {
    const projectPath = join(root, 'PROJECT.md');
    const outputPath = join(root, '.project-view', 'index.html');
    await writeFile(projectPath, VALID_PROJECT, 'utf8');
    await generateProjectView({ projectPath, outputPath });
    const generated = await readFile(outputPath, 'utf8');
    assert.doesNotMatch(generated, /new EventSource/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForSseEvent(url, eventName, action) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4_000);
  let reader;
  try {
    const response = await fetch(url, { signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    reader = response.body.getReader();
    await action();

    const decoder = new TextDecoder();
    let buffer = '';
    while (true) {
      const result = await reader.read();
      if (result.done) throw new Error(`SSE stream ended before ${eventName}.`);
      buffer += decoder.decode(result.value, { stream: true });
      const messages = buffer.split('\n\n');
      buffer = messages.pop();
      for (const message of messages) {
        if (!message.includes(`event: ${eventName}`)) continue;
        const dataLine = message.split('\n').find((line) => line.startsWith('data: '));
        return dataLine?.slice(6) || '';
      }
    }
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    controller.abort();
  }
}

test('server is loopback-only, supports GET and HEAD, reloads, and retains the last valid view', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-project-view-server-'));
  const projectPath = join(root, 'PROJECT.md');
  const outputPath = join(root, '.project-view', 'index.html');
  let runtime;
  try {
    await writeFile(projectPath, VALID_PROJECT, 'utf8');
    runtime = await createProjectViewServer({
      projectPath,
      outputPath,
      port: 0,
      watch: true,
    });

    assert.equal(runtime.host, '127.0.0.1');
    assert.equal(runtime.server.address().address, '127.0.0.1');
    const baseUrl = `http://${runtime.host}:${runtime.port}`;

    const page = await fetch(`${baseUrl}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Vayria \/ Mission Control/);

    const head = await fetch(`${baseUrl}/`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');

    assert.equal((await fetch(`${baseUrl}/missing`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${baseUrl}/events`, { method: 'HEAD' })).status, 405);

    const validOutput = await readFile(outputPath, 'utf8');
    const errorData = await waitForSseEvent(`${baseUrl}/events`, 'source-error', () =>
      writeFile(projectPath, '# invalid\n', 'utf8'));
    assert.match(JSON.parse(errorData), /Missing metadata: Target/);
    assert.equal(await readFile(outputPath, 'utf8'), validOutput);

    const errorPage = await fetch(`${baseUrl}/`);
    const errorHtml = await errorPage.text();
    assert.match(errorHtml, /PROJECT.md error/);
    assert.match(errorHtml, /Missing metadata: Target/);
    assert.match(errorHtml, /Issue #21/);

    const reloadData = await waitForSseEvent(`${baseUrl}/events`, 'reload', () =>
      writeFile(projectPath, VALID_PROJECT.replace('証拠を確認する', '証拠を再確認する'), 'utf8'));
    assert.equal(JSON.parse(reloadData), true);
    assert.match(await readFile(outputPath, 'utf8'), /証拠を再確認する/);

    const replacementPath = `${projectPath}.replacement`;
    const atomicReloadData = await waitForSseEvent(`${baseUrl}/events`, 'reload', async () => {
      await writeFile(replacementPath, VALID_PROJECT.replace('証拠を確認する', '置換保存を確認する'), 'utf8');
      await rename(replacementPath, projectPath);
    });
    assert.equal(JSON.parse(atomicReloadData), true);
    assert.match(await readFile(outputPath, 'utf8'), /置換保存を確認する/);
  } finally {
    await runtime?.close();
    await rm(root, { recursive: true, force: true });
  }
});
