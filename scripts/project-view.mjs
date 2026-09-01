import { createServer } from 'node:http';
import {
  unwatchFile,
  watchFile,
} from 'node:fs';
import {
  access,
  mkdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4178;
const REQUIRED_SECTIONS = ['Phases', 'Now', 'Next', 'Recently Done'];
const HTML_TAG_PATTERN = /<\/?[A-Za-z][^>]*>/;
const MARKDOWN_LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

export class ProjectDocumentError extends Error {
  constructor(message, lineNumber = null) {
    super(lineNumber ? `Line ${lineNumber}: ${message}` : message);
    this.name = 'ProjectDocumentError';
    this.lineNumber = lineNumber;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function validateDate(value, fieldName) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ProjectDocumentError(`${fieldName} must use YYYY-MM-DD.`);
  }
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new ProjectDocumentError(`${fieldName} is not a valid calendar date.`);
  }
}

function validateInlineMarkdown(value, lineNumber) {
  if (HTML_TAG_PATTERN.test(value)) {
    throw new ProjectDocumentError('Raw HTML is not allowed.', lineNumber);
  }

  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(MARKDOWN_LINK_PATTERN)) {
    let url;
    try {
      url = new URL(match[2]);
    } catch {
      throw new ProjectDocumentError(`Invalid link URL: ${match[2]}`, lineNumber);
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new ProjectDocumentError(
        `Link protocol must be http or https: ${match[2]}`,
        lineNumber,
      );
    }
  }

  const withoutValidLinks = value.replace(MARKDOWN_LINK_PATTERN, '');
  if (/\[[^\]]*\]\(|\]\([^)]*$/.test(withoutValidLinks)) {
    throw new ProjectDocumentError('Malformed Markdown link.', lineNumber);
  }
}

function renderInlineMarkdown(value) {
  let output = '';
  let cursor = 0;
  MARKDOWN_LINK_PATTERN.lastIndex = 0;
  for (const match of value.matchAll(MARKDOWN_LINK_PATTERN)) {
    output += escapeHtml(value.slice(cursor, match.index));
    output += `<a href="${escapeHtml(match[2])}" target="_blank" rel="noopener noreferrer">${escapeHtml(match[1])}</a>`;
    cursor = match.index + match[0].length;
  }
  output += escapeHtml(value.slice(cursor));
  return output;
}

export function parseProjectMarkdown(source) {
  const lines = source.replace(/^\uFEFF/, '').replaceAll('\r\n', '\n').split('\n');
  const metadata = new Map();
  const sectionItems = new Map(REQUIRED_SECTIONS.map((section) => [section, []]));
  const seenSections = [];
  let title = null;
  let currentSection = null;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index].trim();
    if (!line) continue;

    if (HTML_TAG_PATTERN.test(line)) {
      throw new ProjectDocumentError('Raw HTML is not allowed.', lineNumber);
    }

    if (title === null) {
      const titleMatch = line.match(/^#\s+(.+)$/);
      if (!titleMatch) {
        throw new ProjectDocumentError('The first content line must be a level-one title.', lineNumber);
      }
      title = titleMatch[1].trim();
      validateInlineMarkdown(title, lineNumber);
      continue;
    }

    const sectionMatch = line.match(/^##\s+(.+)$/);
    if (sectionMatch) {
      const section = sectionMatch[1].trim();
      if (!REQUIRED_SECTIONS.includes(section)) {
        throw new ProjectDocumentError(`Unknown section: ${section}`, lineNumber);
      }
      if (seenSections.includes(section)) {
        throw new ProjectDocumentError(`Duplicate section: ${section}`, lineNumber);
      }
      const expectedSection = REQUIRED_SECTIONS[seenSections.length];
      if (section !== expectedSection) {
        throw new ProjectDocumentError(
          `Expected section "${expectedSection}" before "${section}".`,
          lineNumber,
        );
      }
      seenSections.push(section);
      currentSection = section;
      continue;
    }

    if (currentSection === null) {
      const metadataMatch = line.match(/^-\s+(Target|Reviewed|Phase):\s+(.+)$/);
      if (!metadataMatch) {
        throw new ProjectDocumentError(
          'Expected Target, Reviewed, or Phase metadata.',
          lineNumber,
        );
      }
      const [, key, value] = metadataMatch;
      if (metadata.has(key)) {
        throw new ProjectDocumentError(`Duplicate metadata: ${key}`, lineNumber);
      }
      validateInlineMarkdown(value, lineNumber);
      metadata.set(key, value.trim());
      continue;
    }

    const itemMatch = line.match(/^-\s+(.+)$/);
    if (!itemMatch) {
      throw new ProjectDocumentError('Section content must use one-line list items.', lineNumber);
    }
    const item = itemMatch[1].trim();
    validateInlineMarkdown(item, lineNumber);
    sectionItems.get(currentSection).push({ text: item, lineNumber });
  }

  if (!title) {
    throw new ProjectDocumentError('PROJECT.md is empty.');
  }

  for (const key of ['Target', 'Reviewed', 'Phase']) {
    if (!metadata.has(key)) {
      throw new ProjectDocumentError(`Missing metadata: ${key}`);
    }
  }

  for (const section of REQUIRED_SECTIONS) {
    if (!seenSections.includes(section)) {
      throw new ProjectDocumentError(`Missing section: ${section}`);
    }
    if (sectionItems.get(section).length === 0) {
      throw new ProjectDocumentError(`Section must contain at least one item: ${section}`);
    }
  }

  const target = metadata.get('Target');
  const targetDate = target.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(.+))?$/);
  if (!targetDate) {
    throw new ProjectDocumentError('Target must start with YYYY-MM-DD.');
  }
  validateDate(targetDate[1], 'Target');
  validateDate(metadata.get('Reviewed'), 'Reviewed');

  const phase = metadata.get('Phase').match(/^(\d+)\/(\d+)\s+(.+)$/);
  if (!phase) {
    throw new ProjectDocumentError('Phase must use "current/total label".');
  }
  const phaseCurrent = Number(phase[1]);
  const phaseTotal = Number(phase[2]);
  const phaseLabel = phase[3].trim();
  const phases = sectionItems.get('Phases').map((item) => item.text);
  if (phaseTotal !== phases.length) {
    throw new ProjectDocumentError(
      `Phase total ${phaseTotal} does not match ${phases.length} phase items.`,
    );
  }
  if (phaseCurrent < 1 || phaseCurrent > phaseTotal) {
    throw new ProjectDocumentError('Current phase is outside the phase range.');
  }
  if (phases[phaseCurrent - 1] !== phaseLabel) {
    throw new ProjectDocumentError(
      `Current phase label must match phase ${phaseCurrent}: ${phases[phaseCurrent - 1]}`,
    );
  }

  return {
    title,
    target,
    targetDate: targetDate[1],
    targetLabel: targetDate[2] || '',
    reviewed: metadata.get('Reviewed'),
    phaseCurrent,
    phaseTotal,
    phaseLabel,
    phases,
    now: sectionItems.get('Now').map((item) => item.text),
    next: sectionItems.get('Next').map((item) => item.text),
    recentlyDone: sectionItems.get('Recently Done').map((item) => item.text),
  };
}

function renderPhaseTrack(project) {
  return project.phases.map((phase, index) => {
    const position = index + 1;
    const state = position < project.phaseCurrent
      ? 'previous'
      : position === project.phaseCurrent
        ? 'current'
        : 'future';
    const stateLabel = state === 'current' ? '現在' : state === 'previous' ? '前段階' : '予定';
    const currentAttribute = state === 'current' ? ' aria-current="step"' : '';
    return `
          <li class="phase phase--${state}"${currentAttribute}>
            <span class="phase__dot" aria-hidden="true"></span>
            <span class="phase__state">${stateLabel}</span>
            <span class="phase__label">${escapeHtml(phase)}</span>
          </li>`;
  }).join('');
}

function renderTaskItems(items, kind) {
  return items.map((item, index) => {
    const number = String(index + 1).padStart(2, '0');
    const marker = kind === 'done' ? '✓' : number;
    const accessiblePrefix = kind === 'done' ? '<span class="sr-only">完了: </span>' : '';
    return `
              <li class="task-list__item">
                <span class="task-list__marker" aria-hidden="true">${marker}</span>
                <p>${accessiblePrefix}${renderInlineMarkdown(item)}</p>
              </li>`;
  }).join('');
}

export function renderProjectHtml(project, { liveReload = false } = {}) {
  const [year, month, day] = project.targetDate.split('-');
  const targetDisplay = `${year}.${month}.${day}`;
  const liveReloadScript = liveReload
    ? `<script>
      const sourceError = document.getElementById('source-error');
      const sourceErrorMessage = document.getElementById('source-error-message');
      const events = new EventSource('/events');
      events.addEventListener('reload', () => window.location.reload());
      events.addEventListener('source-error', (event) => {
        sourceErrorMessage.textContent = JSON.parse(event.data);
        sourceError.hidden = false;
      });
    </script>`
    : '';

  return `<!doctype html>
<html lang="ja">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(project.title)}</title>
    <style>
      :root {
        color-scheme: light dark;
        --page: #f2f0eb;
        --surface: #fbfaf7;
        --surface-muted: #e8e5de;
        --ink: #191d1b;
        --muted: #676c68;
        --line: #c9cbc6;
        --accent: #0a7058;
        --accent-soft: #d8ece5;
        --now: #173c35;
        --now-ink: #f3f8f6;
        --danger: #a52b25;
        --danger-soft: #f9dfdc;
        font-family: Inter, "Yu Gothic UI", "Hiragino Sans", system-ui, sans-serif;
      }

      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-width: 320px;
        background: var(--page);
        color: var(--ink);
      }
      a { color: inherit; text-underline-offset: 0.2em; }
      a:hover { text-decoration-thickness: 0.14em; }
      a:focus-visible { outline: 3px solid #e7a83b; outline-offset: 4px; border-radius: 2px; }
      .sr-only {
        position: absolute;
        width: 1px;
        height: 1px;
        padding: 0;
        margin: -1px;
        overflow: hidden;
        clip: rect(0, 0, 0, 0);
        white-space: nowrap;
        border: 0;
      }
      .shell { width: min(1120px, calc(100% - 40px)); margin: 0 auto; padding: 48px 0 64px; }
      .source-error {
        display: flex;
        gap: 12px;
        align-items: baseline;
        margin-bottom: 20px;
        padding: 14px 16px;
        border-left: 5px solid var(--danger);
        background: var(--danger-soft);
        color: #64130f;
      }
      .source-error[hidden] { display: none; }
      .source-error strong { white-space: nowrap; }
      .hero { padding-bottom: 30px; border-bottom: 1px solid var(--line); }
      .eyebrow {
        margin: 0 0 8px;
        color: var(--accent);
        font-size: 0.75rem;
        font-weight: 800;
        letter-spacing: 0.16em;
        text-transform: uppercase;
      }
      h1 { margin: 0; font-size: clamp(2rem, 5vw, 4.25rem); line-height: 0.98; letter-spacing: -0.045em; }
      .mission-meta {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 28px;
        align-items: end;
        margin-top: 28px;
      }
      .target-label { margin: 0 0 4px; color: var(--muted); font-size: 0.8rem; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; }
      .target-date { margin: 0; font-size: clamp(1.5rem, 4vw, 2.6rem); font-weight: 750; letter-spacing: -0.03em; }
      .target-name { margin: 6px 0 0; color: var(--muted); }
      .phase-summary { text-align: right; }
      .phase-summary__count { display: block; color: var(--accent); font-size: 0.85rem; font-weight: 800; letter-spacing: 0.08em; }
      .phase-summary__name { display: block; margin-top: 5px; font-size: 1.25rem; font-weight: 750; }
      .phase-track {
        display: grid;
        grid-template-columns: repeat(${project.phaseTotal}, minmax(0, 1fr));
        margin: 30px 0 0;
        padding: 0;
        list-style: none;
      }
      .phase { position: relative; padding: 21px 14px 0 0; border-top: 2px solid var(--line); }
      .phase__dot {
        position: absolute;
        top: -7px;
        left: 0;
        width: 12px;
        height: 12px;
        border: 2px solid var(--line);
        border-radius: 50%;
        background: var(--surface);
      }
      .phase--previous { border-top-color: #7e918a; }
      .phase--previous .phase__dot { border-color: #7e918a; background: #7e918a; }
      .phase--current { border-top-color: var(--accent); }
      .phase--current .phase__dot { top: -9px; width: 16px; height: 16px; border: 4px solid var(--accent); background: var(--surface); }
      .phase__state { display: block; color: var(--muted); font-size: 0.67rem; font-weight: 800; letter-spacing: 0.08em; }
      .phase--current .phase__state, .phase--current .phase__label { color: var(--accent); }
      .phase__label { display: block; margin-top: 5px; font-size: 0.86rem; font-weight: 700; line-height: 1.35; }
      .work-grid { display: grid; grid-template-columns: minmax(0, 1.1fr) minmax(0, 0.9fr); gap: 18px; margin-top: 26px; }
      .work-section { padding: 28px; }
      .work-section--now { background: var(--now); color: var(--now-ink); }
      .work-section--next { background: var(--surface); border: 1px solid var(--line); }
      .section-heading { display: flex; justify-content: space-between; gap: 16px; align-items: baseline; margin-bottom: 22px; }
      .section-heading h2 { margin: 0; font-size: 1rem; letter-spacing: 0.14em; }
      .section-heading span { color: var(--muted); font-size: 0.76rem; }
      .work-section--now .section-heading span { color: #bdd2cb; }
      .task-list { margin: 0; padding: 0; list-style: none; }
      .task-list__item { display: grid; grid-template-columns: 34px 1fr; gap: 14px; align-items: start; padding: 17px 0; border-top: 1px solid var(--line); }
      .work-section--now .task-list__item { border-top-color: #41645c; }
      .task-list__item:first-child { padding-top: 0; border-top: 0; }
      .task-list__item:last-child { padding-bottom: 0; }
      .task-list__marker { color: var(--accent); font-size: 0.72rem; font-weight: 850; letter-spacing: 0.08em; }
      .work-section--now .task-list__marker { color: #8ed3bc; }
      .task-list p { margin: 0; line-height: 1.65; }
      .done { margin-top: 18px; padding: 24px 28px; background: var(--surface-muted); }
      .done .section-heading { margin-bottom: 14px; }
      .done .task-list { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 24px; }
      .done .task-list__item { grid-template-columns: 24px 1fr; padding: 0; border: 0; color: var(--muted); font-size: 0.9rem; }
      .footer { display: flex; justify-content: space-between; gap: 18px; margin-top: 24px; color: var(--muted); font-size: 0.76rem; }
      .footer p { margin: 0; }

      @media (max-width: 760px) {
        .shell { width: min(100% - 24px, 1120px); padding-top: 28px; }
        .mission-meta, .work-grid { grid-template-columns: 1fr; }
        .phase-summary { text-align: left; }
        .phase-track { display: flex; flex-direction: column; gap: 0; }
        .phase { padding: 4px 0 18px 28px; border-top: 0; border-left: 2px solid var(--line); }
        .phase__dot { top: 3px; left: -7px; }
        .phase--current .phase__dot { top: 1px; left: -9px; }
        .done .task-list { grid-template-columns: 1fr; gap: 16px; }
        .footer { flex-direction: column; }
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --page: #111513;
          --surface: #191e1b;
          --surface-muted: #202622;
          --ink: #edf1ee;
          --muted: #a5ada8;
          --line: #39413c;
          --accent: #74d0b1;
          --accent-soft: #203f35;
          --now: #dcece7;
          --now-ink: #11251f;
          --danger: #ff8b84;
          --danger-soft: #431d1b;
        }
        .source-error { color: #ffd9d6; }
        .work-section--now .section-heading span { color: #486b60; }
        .work-section--now .task-list__item { border-top-color: #b6cec6; }
        .work-section--now .task-list__marker { color: #12644d; }
      }

      @media (prefers-reduced-motion: reduce) {
        *, *::before, *::after { scroll-behavior: auto !important; transition: none !important; animation: none !important; }
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div id="source-error" class="source-error" role="alert" hidden>
        <strong>PROJECT.md error</strong>
        <span id="source-error-message"><!--SOURCE_ERROR--></span>
      </div>

      <header class="hero">
        <p class="eyebrow">Vayria / Mission Control</p>
        <h1>${escapeHtml(project.title.replace(/\s+Mission Control$/i, ''))}</h1>
        <div class="mission-meta">
          <div>
            <p class="target-label">Target</p>
            <p class="target-date"><time datetime="${escapeHtml(project.targetDate)}">${targetDisplay}</time></p>
            <p class="target-name">${escapeHtml(project.targetLabel)}</p>
          </div>
          <div class="phase-summary">
            <span class="phase-summary__count">PHASE ${project.phaseCurrent} / ${project.phaseTotal}</span>
            <span class="phase-summary__name">${escapeHtml(project.phaseLabel)}</span>
          </div>
        </div>
        <ol class="phase-track" aria-label="Project phases">${renderPhaseTrack(project)}
        </ol>
      </header>

      <div class="work-grid">
        <section class="work-section work-section--now" aria-labelledby="now-heading">
          <div class="section-heading">
            <h2 id="now-heading">NOW</h2>
            <span>いま進めること</span>
          </div>
          <ol class="task-list">${renderTaskItems(project.now, 'now')}
          </ol>
        </section>

        <section class="work-section work-section--next" aria-labelledby="next-heading">
          <div class="section-heading">
            <h2 id="next-heading">NEXT</h2>
            <span>次に進めること</span>
          </div>
          <ol class="task-list">${renderTaskItems(project.next, 'next')}
          </ol>
        </section>
      </div>

      <section class="done" aria-labelledby="done-heading">
        <div class="section-heading">
          <h2 id="done-heading">RECENTLY DONE</h2>
          <span>直近の完了</span>
        </div>
        <ul class="task-list">${renderTaskItems(project.recentlyDone, 'done')}
        </ul>
      </section>

      <footer class="footer">
        <p>Reviewed <time datetime="${escapeHtml(project.reviewed)}">${escapeHtml(project.reviewed)}</time></p>
        <p>GitHub Issues = detail · PROJECT.md = current state · HTML = view only</p>
      </footer>
    </main>
    ${liveReloadScript}
  </body>
</html>
`;
}

export async function generateProjectView({
  projectPath,
  outputPath,
  liveReload = false,
}) {
  const source = await readFile(projectPath, 'utf8');
  const project = parseProjectMarkdown(source);
  const html = renderProjectHtml(project, { liveReload });
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, html, 'utf8');
  return { project, html };
}

function injectSourceError(html, errorMessage) {
  if (!errorMessage) return html;
  return html
    .replace('id="source-error" class="source-error" role="alert" hidden', 'id="source-error" class="source-error" role="alert"')
    .replace('<!--SOURCE_ERROR-->', escapeHtml(errorMessage));
}

function sendText(response, statusCode, body, method, headers = {}) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'text/plain; charset=utf-8',
    ...headers,
  });
  if (method !== 'HEAD') response.end(body);
  else response.end();
}

export async function createProjectViewServer({
  projectPath,
  outputPath,
  port = DEFAULT_PORT,
  watch = true,
}) {
  let sourceError = null;
  try {
    await generateProjectView({ projectPath, outputPath, liveReload: true });
  } catch (error) {
    try {
      await access(outputPath);
      sourceError = error instanceof Error ? error.message : String(error);
    } catch {
      throw error;
    }
  }

  const clients = new Set();
  const broadcast = (eventName, data) => {
    const payload = `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const client of clients) client.write(payload);
  };

  const server = createServer(async (request, response) => {
    const method = request.method || 'GET';
    const pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;

    if (pathname === '/events') {
      if (method !== 'GET') {
        sendText(response, 405, 'Method Not Allowed', method, { Allow: 'GET' });
        return;
      }
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'Content-Type': 'text/event-stream; charset=utf-8',
      });
      response.flushHeaders();
      response.write(': connected\n\n');
      clients.add(response);
      request.on('close', () => clients.delete(response));
      return;
    }

    if (method !== 'GET' && method !== 'HEAD') {
      sendText(response, 405, 'Method Not Allowed', method, { Allow: 'GET, HEAD' });
      return;
    }

    if (pathname !== '/') {
      sendText(response, 404, 'Not Found', method);
      return;
    }

    try {
      const generatedHtml = await readFile(outputPath, 'utf8');
      const body = injectSourceError(generatedHtml, sourceError);
      response.writeHead(200, {
        'Cache-Control': 'no-store',
        'Content-Length': Buffer.byteLength(body),
        'Content-Security-Policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
        'Content-Type': 'text/html; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
      });
      if (method === 'GET') response.end(body);
      else response.end();
    } catch (error) {
      sendText(
        response,
        500,
        error instanceof Error ? error.message : String(error),
        method,
      );
    }
  });

  await new Promise((resolvePromise, rejectPromise) => {
    const onError = (error) => rejectPromise(error);
    server.once('error', onError);
    server.listen(port, DEFAULT_HOST, () => {
      server.off('error', onError);
      resolvePromise();
    });
  });

  let debounceTimer = null;
  let pollingListener = null;
  if (watch) {
    const scheduleRegeneration = () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        try {
          await generateProjectView({ projectPath, outputPath, liveReload: true });
          sourceError = null;
          broadcast('reload', true);
        } catch (error) {
          sourceError = error instanceof Error ? error.message : String(error);
          broadcast('source-error', sourceError);
        }
      }, 80);
    };

    // Polling handles both direct writes and atomic replacement without relying
    // on platform-specific directory watcher behavior.
    pollingListener = (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
      scheduleRegeneration();
    };
    watchFile(projectPath, { interval: 250 }, pollingListener);
  }

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    host: DEFAULT_HOST,
    port: actualPort,
    server,
    async close() {
      clearTimeout(debounceTimer);
      if (pollingListener) unwatchFile(projectPath, pollingListener);
      for (const client of clients) client.end();
      clients.clear();
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => error ? rejectPromise(error) : resolvePromise());
      });
    },
  };
}

function readPort(environment) {
  const rawValue = environment.PROJECT_VIEW_PORT?.trim() || String(DEFAULT_PORT);
  const port = Number(rawValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PROJECT_VIEW_PORT must be an integer from 1 to 65535.');
  }
  return port;
}

function parseArguments(argumentsList) {
  const flags = new Set(argumentsList);
  for (const argument of flags) {
    if (argument !== '--serve' && argument !== '--watch') {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  if (flags.has('--watch') && !flags.has('--serve')) {
    throw new Error('--watch requires --serve.');
  }
  return { serve: flags.has('--serve'), watch: flags.has('--watch') };
}

async function runCli() {
  const options = parseArguments(process.argv.slice(2));
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const repositoryRoot = resolve(scriptDirectory, '..');
  const projectPath = join(repositoryRoot, 'PROJECT.md');
  const outputPath = join(repositoryRoot, '.project-view', 'index.html');

  if (!options.serve) {
    await generateProjectView({ projectPath, outputPath });
    console.log(`Generated ${outputPath}`);
    return;
  }

  const runtime = await createProjectViewServer({
    projectPath,
    outputPath,
    port: readPort(process.env),
    watch: options.watch,
  });
  console.log(`Vayria Mission Control: http://${runtime.host}:${runtime.port}/`);

  const shutdown = async () => {
    await runtime.close();
    process.exitCode = 0;
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

const invokedModule = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedModule === import.meta.url) {
  runCli().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
