import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  appendObservationRecord,
  parseObservationCommand,
  resolveCaptureSelection,
  resolveLocalRoot,
} from './exhibition-capture.mjs';

function writeLine(output, value = '') {
  output.write(`${value}\n`);
}

function readOptionValue(argv, index, optionName) {
  const argument = argv[index];
  if (argument.includes('=')) {
    return [argument.slice(argument.indexOf('=') + 1), index];
  }
  const next = argv[index + 1];
  if (!next || next.startsWith('--')) {
    throw new Error(`${optionName} requires a value.`);
  }
  return [next, index + 1];
}

export function parseObserveArgs(
  argv,
  environment = process.env,
) {
  const options = {
    captureId: null,
    latest: false,
    help: false,
    localRoot: resolveLocalRoot(environment),
  };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') {
      options.help = true;
      continue;
    }
    if (argument === '--latest') {
      options.latest = true;
      continue;
    }
    if (argument === '--capture-id' || argument.startsWith('--capture-id=')) {
      const [value, nextIndex] = readOptionValue(argv, index, '--capture-id');
      if (!value.trim()) throw new Error('--capture-id must not be empty.');
      options.captureId = value.trim();
      index = nextIndex;
      continue;
    }
    if (argument === '--local-root' || argument.startsWith('--local-root=')) {
      const [value, nextIndex] = readOptionValue(argv, index, '--local-root');
      if (!value.trim()) throw new Error('--local-root must not be empty.');
      options.localRoot = value;
      index = nextIndex;
      continue;
    }
    throw new Error(`Unknown option: ${argument}`);
  }

  if (options.captureId && options.latest) {
    throw new Error('Use either --capture-id or --latest, not both.');
  }
  return options;
}

export function observerHelp(output = process.stdout) {
  writeLine(output, 'Vayria exhibition observation input:');
  writeLine(output, '  npm run exhibition:observe -- --capture-id <captureId>');
  writeLine(output, '  npm run exhibition:observe -- --latest');
  writeLine(output, '');
  writeLine(output, 'Commands:');
  writeLine(output, '  note <短文>');
  writeLine(output, '  score <axis> <0|1|2|3|N/A> [reason]');
  writeLine(output, '  help');
  writeLine(output, '  exit');
}

export async function runObserver({
  localRoot = resolveLocalRoot(),
  captureId = null,
  latest = false,
  input = process.stdin,
  output = process.stdout,
  now = () => new Date().toISOString(),
} = {}) {
  const selected = await resolveCaptureSelection({
    localRoot,
    captureId,
    latest,
  });
  writeLine(output, `Exhibition capture: ${selected.captureId}`);
  writeLine(output, `Status: ${selected.metadata.status}`);
  writeLine(output, 'note <短文> または score <axis> <0|1|2|3|N/A> [reason] を入力してください。');
  writeLine(output, '終了する場合は exit を入力してください。');

  const terminal = Boolean(input.isTTY && output.isTTY);
  const readline = createInterface({ input, output, terminal });
  let savedCount = 0;
  try {
    if (terminal) output.write('> ');
    for await (const line of readline) {
      try {
        const parsed = parseObservationCommand(line);
        if (parsed.command === 'empty') {
          if (terminal) output.write('> ');
          continue;
        }
        if (parsed.command === 'help') {
          observerHelp(output);
          if (terminal) output.write('> ');
          continue;
        }
        if (parsed.command === 'exit') break;

        const record = await appendObservationRecord(
          localRoot,
          selected.captureId,
          parsed,
          now(),
        );
        savedCount += 1;
        writeLine(output, `保存しました: ${record.type}`);
      } catch (error) {
        writeLine(
          output,
          `入力エラー: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (terminal) output.write('> ');
    }
  } finally {
    readline.close();
  }
  return { ...selected, savedCount };
}

function printHelp() {
  observerHelp();
}

async function main() {
  const options = parseObserveArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  await runObserver(options);
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(
      `Exhibition observe error: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
