import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { resolveHttpsOptions } from '../server/httpsConfig.js';
import { resolveOpenAiApiKey } from '../server/secretConfig.js';

async function removeDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function createHttpsConfigFiles(): Promise<{
  certificateFile: string;
  configFile: string;
  directory: string;
  privateKeyFile: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'vayria https config-'));
  const certificateFile = join(directory, 'certificate.pem');
  const privateKeyFile = join(directory, 'private-key.pem');
  const configFile = join(directory, 'https.env');
  await writeFile(certificateFile, 'CERTIFICATE_CONTENT', 'utf8');
  await writeFile(privateKeyFile, 'PRIVATE_KEY_CONTENT', 'utf8');
  await writeFile(
    configFile,
    [
      'VAYRIA_HTTPS=true',
      `VAYRIA_HTTPS_CERT_FILE="${certificateFile}"`,
      `VAYRIA_HTTPS_KEY_FILE=${privateKeyFile}`,
    ].join('\n'),
    'utf8',
  );
  return { certificateFile, configFile, directory, privateKeyFile };
}

test('process environment can provide the injected API key', () => {
  assert.equal(
    resolveOpenAiApiKey({ OPENAI_API_KEY: 'sk-test-process-key' }),
    'sk-test-process-key',
  );
});

test('missing process environment returns no API key', () => {
  assert.equal(resolveOpenAiApiKey({}), undefined);
});

test('an unresolved 1Password reference is rejected', () => {
  assert.throws(
    () => resolveOpenAiApiKey({ OPENAI_API_KEY: 'op://vault/item/field' }),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        'OPENAI_API_KEY contains an unresolved 1Password reference. Start with a Vayria :op command.',
  );
});

test('a normal process key remains available to the server', () => {
  assert.equal(
    resolveOpenAiApiKey({ OPENAI_API_KEY: 'sk-test-process-key-2' }),
    'sk-test-process-key-2',
  );
});

test('shared HTTPS settings override direct worktree settings', async () => {
  const files = await createHttpsConfigFiles();

  try {
    const options = resolveHttpsOptions(
      {
        VAYRIA_HTTPS: 'false',
        VAYRIA_HTTPS_CERT_FILE: 'C:\\missing\\certificate.pem',
        VAYRIA_HTTPS_CONFIG_FILE: files.configFile,
        VAYRIA_HTTPS_KEY_FILE: 'C:\\missing\\private-key.pem',
      },
      {},
    );

    assert.deepEqual(options, {
      cert: Buffer.from('CERTIFICATE_CONTENT'),
      key: Buffer.from('PRIVATE_KEY_CONTENT'),
    });
  } finally {
    await removeDirectory(files.directory);
  }
});

test('direct HTTPS settings remain supported without a shared config file', async () => {
  const files = await createHttpsConfigFiles();

  try {
    const options = resolveHttpsOptions(
      {
        VAYRIA_HTTPS: 'true',
        VAYRIA_HTTPS_CERT_FILE: files.certificateFile,
        VAYRIA_HTTPS_KEY_FILE: files.privateKeyFile,
      },
      {},
    );

    assert.deepEqual(options, {
      cert: Buffer.from('CERTIFICATE_CONTENT'),
      key: Buffer.from('PRIVATE_KEY_CONTENT'),
    });
  } finally {
    await removeDirectory(files.directory);
  }
});

test('process environment can provide the shared HTTPS settings reference', async () => {
  const files = await createHttpsConfigFiles();

  try {
    const options = resolveHttpsOptions(
      { VAYRIA_HTTPS: 'false' },
      { VAYRIA_HTTPS_CONFIG_FILE: files.configFile },
    );

    assert.deepEqual(options, {
      cert: Buffer.from('CERTIFICATE_CONTENT'),
      key: Buffer.from('PRIVATE_KEY_CONTENT'),
    });
  } finally {
    await removeDirectory(files.directory);
  }
});

test('disabled shared HTTPS settings do not read certificate files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'vayria disabled https-'));
  const configFile = join(directory, 'https.env');

  try {
    await writeFile(
      configFile,
      [
        'VAYRIA_HTTPS=false',
        'VAYRIA_HTTPS_CERT_FILE=C:\\missing\\certificate.pem',
        'VAYRIA_HTTPS_KEY_FILE=C:\\missing\\private-key.pem',
      ].join('\n'),
      'utf8',
    );

    assert.equal(
      resolveHttpsOptions(
        { VAYRIA_HTTPS_CONFIG_FILE: configFile },
        {},
      ),
      undefined,
    );
  } finally {
    await removeDirectory(directory);
  }
});

test('HTTPS config references require an absolute existing file', async () => {
  assert.throws(
    () =>
      resolveHttpsOptions(
        { VAYRIA_HTTPS_CONFIG_FILE: '.https.env' },
        {},
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'VAYRIA_HTTPS_CONFIG_FILE must be an absolute path.',
  );

  assert.throws(
    () =>
      resolveHttpsOptions(
        { VAYRIA_HTTPS_CONFIG_FILE: 'C:\\missing\\https.env' },
        {},
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === 'VAYRIA_HTTPS_CONFIG_FILE could not be read.',
  );

  const directory = await mkdtemp(join(tmpdir(), 'vayria relative https-'));
  const configFile = join(directory, 'https.env');
  try {
    await writeFile(
      configFile,
      [
        'VAYRIA_HTTPS=true',
        'VAYRIA_HTTPS_CERT_FILE=certificate.pem',
        'VAYRIA_HTTPS_KEY_FILE=private-key.pem',
      ].join('\n'),
      'utf8',
    );

    assert.throws(
      () => resolveHttpsOptions({ VAYRIA_HTTPS_CONFIG_FILE: configFile }, {}),
      (error: unknown) =>
        error instanceof Error &&
        error.message === 'VAYRIA_HTTPS_CERT_FILE must be an absolute path.',
    );
  } finally {
    await removeDirectory(directory);
  }
});

test('HTTPS errors require certificate files without exposing file contents', async () => {
  const files = await createHttpsConfigFiles();
  const missingKeyFile = join(files.directory, 'missing-private-key.pem');

  try {
    await writeFile(
      files.configFile,
      [
        'VAYRIA_HTTPS=true',
        `VAYRIA_HTTPS_CERT_FILE=${files.certificateFile}`,
        `VAYRIA_HTTPS_KEY_FILE=${missingKeyFile}`,
      ].join('\n'),
      'utf8',
    );

    assert.throws(
      () => resolveHttpsOptions({ VAYRIA_HTTPS_CONFIG_FILE: files.configFile }, {}),
      (error: unknown) =>
        error instanceof Error &&
        error.message.includes('Vayria HTTPS certificate files could not be read:') &&
        !error.message.includes('CERTIFICATE_CONTENT') &&
        !error.message.includes('PRIVATE_KEY_CONTENT') &&
        !error.message.includes('sk-'),
    );
  } finally {
    await removeDirectory(files.directory);
  }
});
