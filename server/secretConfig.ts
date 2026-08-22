import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const SECRET_FILE_ENV_NAME = 'VAYRIA_SECRET_FILE';
const OPENAI_API_KEY_ENV_NAME = 'OPENAI_API_KEY';

type Environment = Readonly<Record<string, string | undefined>>;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

function parseEnvValue(rawValue: string): string {
  const trimmedValue = rawValue.trim();
  if (
    trimmedValue.length >= 2 &&
    ((trimmedValue.startsWith('"') && trimmedValue.endsWith('"')) ||
      (trimmedValue.startsWith("'") && trimmedValue.endsWith("'")))
  ) {
    return trimmedValue.slice(1, -1);
  }

  const commentIndex = trimmedValue.search(/\s+#/);
  return (commentIndex >= 0
    ? trimmedValue.slice(0, commentIndex)
    : trimmedValue
  ).trim();
}

function readOpenAiApiKeyFromText(contents: string): string | undefined {
  let apiKey: string | undefined;

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?OPENAI_API_KEY\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;

    const value = parseEnvValue(match[1]);
    apiKey = value || undefined;
  }

  return apiKey;
}

function readExternalOpenAiApiKey(secretFile: string): string {
  if (!isAbsolute(secretFile)) {
    throw new Error('VAYRIA_SECRET_FILE must be an absolute path.');
  }

  const secretFilePath = resolve(secretFile);
  let contents: string;
  try {
    contents = readFileSync(secretFilePath, 'utf8');
  } catch {
    throw new Error('VAYRIA_SECRET_FILE could not be read.');
  }

  const apiKey = readOpenAiApiKeyFromText(contents);
  if (!apiKey) {
    throw new Error(
      'VAYRIA_SECRET_FILE does not contain OPENAI_API_KEY.',
    );
  }

  return apiKey;
}

export function resolveOpenAiApiKey(
  environment: Environment,
  processEnvironment: Environment = process.env,
): string | undefined {
  const secretFile = firstNonEmpty(
    environment[SECRET_FILE_ENV_NAME],
    processEnvironment[SECRET_FILE_ENV_NAME],
  );

  if (secretFile) {
    return readExternalOpenAiApiKey(secretFile);
  }

  return firstNonEmpty(
    environment[OPENAI_API_KEY_ENV_NAME],
    processEnvironment[OPENAI_API_KEY_ENV_NAME],
  );
}
