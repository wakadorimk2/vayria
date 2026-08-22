import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer, loadEnv } from 'vite';
import { openQrPage, startRun } from './playcheck.mjs';

const EXHIBITION_MODE = 'exhibition';
const DEFAULT_LOCAL_ROOT = 'playcheck-results/local';

function writeLine(output, value = '') {
  output.write(`${value}\n`);
}

export function parseIpadArgs(argv) {
  let openQr = true;
  let help = false;

  for (const argument of argv) {
    if (argument === '--no-open-qr') {
      openQr = false;
      continue;
    }
    if (argument === '--help' || argument === '-h') {
      help = true;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  return { help, openQr };
}

export function selectNetworkUrls(resolvedUrls) {
  const networkUrls = Array.isArray(resolvedUrls?.network)
    ? resolvedUrls.network.filter(
        (url) => typeof url === 'string' && url.trim(),
      )
    : [];

  if (networkUrls.length === 0) {
    throw new Error(
      'ViteがLAN用のNetwork URLを返しませんでした。' +
        ' .env.exhibition.localのVAYRIA_BIND_HOSTを0.0.0.0に設定し、' +
        'PCとiPadを同じLANへ接続してください。',
    );
  }

  return networkUrls.map((url) => url.trim());
}

function resolveLocalRoot(environment) {
  return environment?.VAYRIA_PLAYCHECK_ROOT?.trim() || DEFAULT_LOCAL_ROOT;
}

export async function startIpadPlaycheck({
  createViteServer = createServer,
  loadEnvironment = loadEnv,
  startRunFn = startRun,
  openQrPageFn = openQrPage,
  openQr = true,
  cwd = process.cwd(),
  output = process.stdout,
} = {}) {
  const environment = loadEnvironment(EXHIBITION_MODE, cwd, '');
  const localRoot = resolveLocalRoot(environment);
  let server;

  try {
    server = await createViteServer({
      mode: EXHIBITION_MODE,
      root: cwd,
    });
    await server.listen();

    const networkUrls = selectNetworkUrls(server.resolvedUrls);
    const run = await startRunFn({
      baseUrl: networkUrls[0],
      localRoot,
    });

    if (openQr) {
      try {
        openQrPageFn(run.qrPath);
      } catch (error) {
        writeLine(
          output,
          `QRページを自動で開けませんでした。パスをブラウザーで開いてください: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }

    writeLine(output, 'Vayria iPad Owner Playcheck');
    writeLine(output, `Playcheck run: ${run.runId}`);
    writeLine(output, `Open: ${run.url}`);
    writeLine(output, `QR page: ${run.qrPath}`);
    networkUrls.forEach((url, index) => {
      writeLine(output, `Network URL ${index + 1}: ${url}`);
    });
    writeLine(output, `Score: npm run playcheck -- score --run-id ${run.runId}`);
    writeLine(output, `State: ${run.workPath}`);
    writeLine(output, `Raw events: ${run.rawPath}`);
    writeLine(output, 'Ctrl+CでViteを安全に停止します。');
    writeLine(output, '評価runの状態とイベントは保存先に保持します。');

    return { localRoot, networkUrls, run, server };
  } catch (error) {
    if (server) {
      await server.close().catch(() => undefined);
    }
    throw error;
  }
}

export function waitForShutdown(server, { signalSource = process } = {}) {
  return new Promise((resolve, reject) => {
    let stopping = false;

    const cleanup = () => {
      signalSource.removeListener?.('SIGINT', onInterrupt);
      signalSource.removeListener?.('SIGTERM', onTerminate);
    };

    const stop = async (signal) => {
      if (stopping) return;
      stopping = true;
      cleanup();
      try {
        await server.close();
        resolve(signal);
      } catch (error) {
        reject(error);
      }
    };

    const onInterrupt = () => {
      void stop('SIGINT');
    };
    const onTerminate = () => {
      void stop('SIGTERM');
    };

    signalSource.once('SIGINT', onInterrupt);
    signalSource.once('SIGTERM', onTerminate);
  });
}

function printHelp(output = process.stdout) {
  writeLine(output, 'Vayria iPad Owner Playcheck:');
  writeLine(output, '  npm run playcheck:ipad');
  writeLine(output, '  npm run playcheck:ipad -- --no-open-qr');
  writeLine(output, '');
  writeLine(output, 'exhibitionモードのViteを起動し、LAN URLから評価runとQRページを作成します。');
}

async function main() {
  const options = parseIpadArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const session = await startIpadPlaycheck(options);
  await waitForShutdown(session.server);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `Playcheck iPad error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
