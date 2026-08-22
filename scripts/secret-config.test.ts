import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveOpenAiApiKey } from '../server/secretConfig.js';

async function createSecretFile(contents: string): Promise<{
  directory: string;
  file: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'vayria secret config-'));
  const file = join(directory, 'secrets.env');
  await writeFile(file, contents, 'utf8');
  return { directory, file };
}

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

test('external secret file overrides the legacy environment key', async () => {
  const { directory, file } = await createSecretFile(
    '# CRLF and quoted values are supported\r\n' +
      'OPENAI_API_KEY = "sk-test-external=with-equals"\r\n' +
      'UNUSED_VALUE=ignored\r\n',
  );

  try {
    assert.equal(
      resolveOpenAiApiKey(
        {
          OPENAI_API_KEY: 'sk-test-legacy',
          VAYRIA_SECRET_FILE: file,
        },
        {},
      ),
      'sk-test-external=with-equals',
    );
  } finally {
    await removeDirectory(directory);
  }
});

test('process environment can provide the external secret file reference', async () => {
  const { directory, file } = await createSecretFile(
    'export OPENAI_API_KEY=sk-test-process\n',
  );

  try {
    assert.equal(
      resolveOpenAiApiKey({}, { VAYRIA_SECRET_FILE: file }),
      'sk-test-process',
    );
  } finally {
    await removeDirectory(directory);
  }
});

test('legacy environment configuration remains supported', () => {
  assert.equal(
    resolveOpenAiApiKey(
      { OPENAI_API_KEY: 'sk-test-legacy' },
      {},
    ),
    'sk-test-legacy',
  );
});

test('a configured but missing secret file fails without exposing its path or contents', () => {
  assert.throws(
    () =>
      resolveOpenAiApiKey(
        { VAYRIA_SECRET_FILE: 'C:\\missing\\vayria-secrets.env' },
        {},
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'VAYRIA_SECRET_FILE could not be read.',
  );
});

test('a secret file without OPENAI_API_KEY fails with a redacted error', async () => {
  const { directory, file } = await createSecretFile('OTHER_VALUE=ignored\n');

  try {
    assert.throws(
      () => resolveOpenAiApiKey({ VAYRIA_SECRET_FILE: file }, {}),
      (error: unknown) =>
        error instanceof Error &&
        error.message ===
          'VAYRIA_SECRET_FILE does not contain OPENAI_API_KEY.',
    );
  } finally {
    await removeDirectory(directory);
  }
});

test('a relative secret file reference is rejected', () => {
  assert.throws(
    () => resolveOpenAiApiKey({ VAYRIA_SECRET_FILE: '.secrets.env' }, {}),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'VAYRIA_SECRET_FILE must be an absolute path.',
  );
});
