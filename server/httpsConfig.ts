import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

const HTTPS_CONFIG_FILE_ENV_NAME = 'VAYRIA_HTTPS_CONFIG_FILE';
type HttpsEnvironmentName =
  | 'VAYRIA_HTTPS'
  | 'VAYRIA_HTTPS_CERT_FILE'
  | 'VAYRIA_HTTPS_KEY_FILE';
type Environment = Readonly<Record<string, string | undefined>>;
type HttpsEnvironment = Partial<Record<HttpsEnvironmentName, string>>;

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

function readHttpsEnvironmentFromText(contents: string): HttpsEnvironment {
  const values: HttpsEnvironment = {};

  for (const line of contents.split(/\r?\n/)) {
    const match = line.match(
      /^\s*(?:export\s+)?(VAYRIA_HTTPS_CERT_FILE|VAYRIA_HTTPS_KEY_FILE|VAYRIA_HTTPS)\s*=\s*(.*?)\s*$/,
    );
    if (!match) continue;

    const name = match[1] as HttpsEnvironmentName;
    values[name] = parseEnvValue(match[2]);
  }

  return values;
}

function readExternalHttpsEnvironment(configFile: string): HttpsEnvironment {
  if (!isAbsolute(configFile)) {
    throw new Error('VAYRIA_HTTPS_CONFIG_FILE must be an absolute path.');
  }

  const configFilePath = resolve(configFile);
  let contents: string;
  try {
    contents = readFileSync(configFilePath, 'utf8');
  } catch {
    throw new Error('VAYRIA_HTTPS_CONFIG_FILE could not be read.');
  }

  const values = readHttpsEnvironmentFromText(contents);
  if (Object.keys(values).length === 0) {
    throw new Error(
      'VAYRIA_HTTPS_CONFIG_FILE does not contain HTTPS settings.',
    );
  }

  return values;
}

function isEnabled(value: string | undefined): boolean {
  return ['1', 'true', 'yes', 'on'].includes(
    value?.trim().toLowerCase() ?? '',
  );
}

function readHttpsOptions(
  environment: Environment,
  requireAbsoluteFilePaths = false,
): { cert: Buffer; key: Buffer } | undefined {
  if (!isEnabled(environment.VAYRIA_HTTPS)) return undefined;

  const certificateFile = environment.VAYRIA_HTTPS_CERT_FILE?.trim();
  const privateKeyFile = environment.VAYRIA_HTTPS_KEY_FILE?.trim();
  if (!certificateFile || !privateKeyFile) {
    throw new Error(
      'VAYRIA_HTTPS_CERT_FILE and VAYRIA_HTTPS_KEY_FILE are required when VAYRIA_HTTPS is enabled.',
    );
  }

  if (requireAbsoluteFilePaths) {
    if (!isAbsolute(certificateFile)) {
      throw new Error('VAYRIA_HTTPS_CERT_FILE must be an absolute path.');
    }
    if (!isAbsolute(privateKeyFile)) {
      throw new Error('VAYRIA_HTTPS_KEY_FILE must be an absolute path.');
    }
  }

  try {
    return {
      cert: readFileSync(certificateFile),
      key: readFileSync(privateKeyFile),
    };
  } catch (error) {
    throw new Error(
      `Vayria HTTPS certificate files could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export function resolveHttpsOptions(
  environment: Environment,
  processEnvironment: Environment = process.env,
): { cert: Buffer; key: Buffer } | undefined {
  const configFile = firstNonEmpty(
    environment[HTTPS_CONFIG_FILE_ENV_NAME],
    processEnvironment[HTTPS_CONFIG_FILE_ENV_NAME],
  );

  if (!configFile) return readHttpsOptions(environment);

  const sharedEnvironment = readExternalHttpsEnvironment(configFile);
  return readHttpsOptions({ ...environment, ...sharedEnvironment }, true);
}
