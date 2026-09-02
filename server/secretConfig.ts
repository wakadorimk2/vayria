const OPENAI_API_KEY_ENV_NAME = 'OPENAI_API_KEY';
const AIVIS_CLOUD_API_KEY_ENV_NAME = 'AIVIS_CLOUD_API_KEY';

type Environment = Readonly<Record<string, string | undefined>>;

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.map((value) => value?.trim()).find(Boolean);
}

export function resolveOpenAiApiKey(
  processEnvironment: Environment = process.env,
): string | undefined {
  const apiKey = firstNonEmpty(
    processEnvironment[OPENAI_API_KEY_ENV_NAME],
  );

  if (apiKey?.toLowerCase().startsWith('op://')) {
    throw new Error(
      'OPENAI_API_KEY contains an unresolved 1Password reference. Start with a Vayria :op command.',
    );
  }

  return apiKey;
}

export function resolveAivisCloudApiKey(
  processEnvironment: Environment = process.env,
): string | undefined {
  const apiKey = firstNonEmpty(
    processEnvironment[AIVIS_CLOUD_API_KEY_ENV_NAME],
  );

  if (apiKey?.toLowerCase().startsWith('op://')) {
    throw new Error(
      'AIVIS_CLOUD_API_KEY contains an unresolved 1Password reference. Start with a Vayria :op command.',
    );
  }

  return apiKey;
}
