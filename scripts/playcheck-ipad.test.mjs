import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  parseIpadArgs,
  selectNetworkUrls,
  startIpadPlaycheck,
  waitForShutdown,
} from './playcheck-ipad.mjs';

function createOutput() {
  const lines = [];
  return {
    lines,
    write(value) {
      lines.push(value);
    },
  };
}

function createRun() {
  return {
    runId: 'pc-20260822-abcdef12',
    url: 'http://192.168.1.20:5187/?playcheckRunId=pc-20260822-abcdef12',
    qrPath: 'playcheck-results/local/launch/pc-20260822-abcdef12.html',
    workPath: 'playcheck-results/local/work/pc-20260822-abcdef12.json',
    rawPath: 'playcheck-results/local/raw/pc-20260822-abcdef12.jsonl',
  };
}

test('iPad arguments support QR suppression', () => {
  assert.deepEqual(parseIpadArgs([]), { help: false, openQr: true });
  assert.deepEqual(parseIpadArgs(['--no-open-qr']), {
    help: false,
    openQr: false,
  });
  assert.equal(parseIpadArgs(['--help']).help, true);
  assert.throws(() => parseIpadArgs(['--base-url']), /Unknown option/);
});

test('network URLs use the first URL for the QR and preserve alternatives', () => {
  assert.deepEqual(
    selectNetworkUrls({
      network: [
        'http://192.168.1.20:5187/',
        'http://10.0.0.20:5187/',
        '',
        null,
      ],
    }),
    ['http://192.168.1.20:5187/', 'http://10.0.0.20:5187/'],
  );
});

test('missing network URLs produce an actionable error', () => {
  assert.throws(
    () => selectNetworkUrls({ network: [] }),
    /ViteがLAN用のNetwork URLを返しませんでした/,
  );
});

test('iPad startup creates a run with the configured playcheck root', async () => {
  let closed = false;
  let startRunOptions;
  let openedQrPath;
  const output = createOutput();
  const server = {
    resolvedUrls: {
      network: ['http://192.168.1.20:5187/', 'http://10.0.0.20:5187/'],
    },
    async listen() {},
    async close() {
      closed = true;
    },
  };

  const session = await startIpadPlaycheck({
    createViteServer: async () => server,
    loadEnvironment: () => ({ VAYRIA_PLAYCHECK_ROOT: 'custom-playcheck-root' }),
    startRunFn: async (options) => {
      startRunOptions = options;
      return createRun();
    },
    openQrPageFn: (path) => {
      openedQrPath = path;
    },
    output,
  });

  assert.equal(session.localRoot, 'custom-playcheck-root');
  assert.equal(startRunOptions.baseUrl, 'http://192.168.1.20:5187/');
  assert.equal(startRunOptions.localRoot, 'custom-playcheck-root');
  assert.equal(openedQrPath, createRun().qrPath);
  assert.match(output.lines.join(''), /Playcheck run: pc-20260822-abcdef12/);
  assert.match(
    output.lines.join(''),
    /QR page: playcheck-results\/local\/launch\/pc-20260822-abcdef12\.html/,
  );
  assert.match(output.lines.join(''), /Network URL 2: http:\/\/10\.0\.0\.20:5187\//);
  assert.match(output.lines.join(''), /npm run playcheck -- score --run-id pc-20260822-abcdef12/);
  assert.match(output.lines.join(''), /Ctrl\+CでViteを安全に停止します/);

  await session.server.close();
  assert.equal(closed, true);
});

test('iPad startup does not open a QR page when requested', async () => {
  let opened = false;
  const server = {
    resolvedUrls: { network: ['http://192.168.1.20:5187/'] },
    async listen() {},
    async close() {},
  };

  const session = await startIpadPlaycheck({
    createViteServer: async () => server,
    loadEnvironment: () => ({}),
    startRunFn: async () => createRun(),
    openQrPageFn: () => {
      opened = true;
    },
    openQr: false,
    output: createOutput(),
  });

  assert.equal(opened, false);
  await session.server.close();
});

test('iPad startup closes Vite when no network URL exists', async () => {
  let closed = false;
  const server = {
    resolvedUrls: { network: [] },
    async listen() {},
    async close() {
      closed = true;
    },
  };

  await assert.rejects(
    startIpadPlaycheck({
      createViteServer: async () => server,
      loadEnvironment: () => ({}),
      output: createOutput(),
    }),
    /ViteがLAN用のNetwork URLを返しませんでした/,
  );
  assert.equal(closed, true);
});

test('shutdown closes the server on Ctrl+C', async () => {
  const signals = new EventEmitter();
  let closed = false;
  const shutdown = waitForShutdown(
    {
      async close() {
        closed = true;
      },
    },
    { signalSource: signals },
  );

  signals.emit('SIGINT');
  assert.equal(await shutdown, 'SIGINT');
  assert.equal(closed, true);
});
