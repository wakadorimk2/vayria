export const CHARACTER_IDENTITY_STORAGE_KEY =
  'vayria.character-identity.v1';

export const MAX_CHARACTER_ALIAS_COUNT = 16;
export const MAX_CHARACTER_ALIAS_LENGTH = 32;

export interface CharacterIdentity {
  version: 1;
  canonicalName: 'Vayria';
  displayName: 'ヴェイリア';
  aliases: string[];
}

export type SelfNameRole =
  | 'direct_address'
  | 'self_reference'
  | 'none';

export type SelfNameMatch =
  | 'canonical'
  | 'alias'
  | 'phonetic'
  | 'none';

export interface SelfNameResolution {
  role: SelfNameRole;
  match: SelfNameMatch;
  matchedText: string | null;
  canonicalName: 'Vayria';
  displayName: 'ヴェイリア';
}

export interface CharacterIdentityStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const DEFAULT_CHARACTER_IDENTITY: CharacterIdentity = {
  version: 1,
  canonicalName: 'Vayria',
  displayName: 'ヴェイリア',
  aliases: [],
};

const PHONETIC_NAME_FORMS = [
  'ヴェイリア',
  'ベイリア',
  'ウェイリア',
  'ヴァイリア',
  'バイリア',
  'ヴェイリヤ',
  'ベイリヤ',
  'ヴェリア',
  'ベリア',
  'Vayria',
  'Varia',
  'Vairia',
  'Vaylia',
] as const;

const NAME_CHAR_PATTERN =
  /[A-Za-zＡ-Ｚａ-ｚぁ-ゖァ-ヶー\u3400-\u9fff]/u;
const NAME_CHAR_SEQUENCE_PATTERN =
  /^[A-Za-zＡ-Ｚａ-ｚぁ-ゖァ-ヶー\u3400-\u9fff]+(?:\s+[A-Za-zＡ-Ｚａ-ｚぁ-ゖァ-ヶー\u3400-\u9fff]+)*$/u;
const BOUNDARY_PUNCTUATION =
  '、,，。．.!！?？…:：;；「」『』"“”';
const BOUNDARY_PUNCTUATION_PATTERN = new RegExp(
  `[\\s${BOUNDARY_PUNCTUATION}]+`,
  'u',
);
const BOUNDARY_ONLY_PATTERN = new RegExp(
  `^[\\s${BOUNDARY_PUNCTUATION}]*$`,
  'u',
);
const NAME_SCAN_MAX_LENGTH = MAX_CHARACTER_ALIAS_LENGTH + 8;
const HONORIFIC_PATTERN = /^\s*(?:さん|ちゃん)\s*/u;
const SELF_REFERENCE_PARTICLE_PATTERN =
  /^\s*(?:は|が|の|って|という|っていう|に|を|も|へ|と|から|として|なら|について)/u;
const VOCATIVE_PREFIX_PATTERN =
  /(?:^|[\s、,，。．.!！?？…:：;；「」『』"“”])(?:ねえ|ねぇ)\s*[、,，。．.!！?？…:：;；]?\s*$/u;
function cloneDefaultCharacterIdentity(): CharacterIdentity {
  return {
    version: DEFAULT_CHARACTER_IDENTITY.version,
    canonicalName: DEFAULT_CHARACTER_IDENTITY.canonicalName,
    displayName: DEFAULT_CHARACTER_IDENTITY.displayName,
    aliases: [],
  };
}

function unifyKana(value: string): string {
  return Array.from(value, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint >= 0x3041 && codePoint <= 0x3096) {
      return String.fromCodePoint(codePoint + 0x60);
    }
    return character;
  }).join('');
}

function normalizeNameKey(value: string): string {
  return unifyKana(value.normalize('NFKC').toLocaleLowerCase('en-US'))
    .replace(/\s+/gu, '')
    .replace(BOUNDARY_PUNCTUATION_PATTERN, '');
}

function normalizeAliasText(value: string): string | null {
  const normalized = value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  if (
    !normalized ||
    Array.from(normalized).length > MAX_CHARACTER_ALIAS_LENGTH ||
    !NAME_CHAR_SEQUENCE_PATTERN.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function isSameNameKey(left: string, right: string): boolean {
  return normalizeNameKey(left) === normalizeNameKey(right);
}

function isValidAliasList(aliases: unknown): aliases is string[] {
  if (!Array.isArray(aliases) || aliases.length > MAX_CHARACTER_ALIAS_COUNT) {
    return false;
  }

  const keys = new Set<string>();
  for (const alias of aliases) {
    if (typeof alias !== 'string') return false;
    const normalizedAlias = normalizeAliasText(alias);
    if (normalizedAlias === null || normalizedAlias !== alias) {
      return false;
    }
    const key = normalizeNameKey(normalizedAlias);
    if (!key || keys.has(key)) return false;
    if (
      isSameNameKey(normalizedAlias, DEFAULT_CHARACTER_IDENTITY.canonicalName) ||
      isSameNameKey(normalizedAlias, DEFAULT_CHARACTER_IDENTITY.displayName)
    ) {
      return false;
    }
    keys.add(key);
  }
  return true;
}

export function parseCharacterIdentity(
  value: unknown,
): CharacterIdentity | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        key !== 'version' &&
        key !== 'canonicalName' &&
        key !== 'displayName' &&
        key !== 'aliases',
    ) ||
    record.version !== 1 ||
    record.canonicalName !== DEFAULT_CHARACTER_IDENTITY.canonicalName ||
    record.displayName !== DEFAULT_CHARACTER_IDENTITY.displayName ||
    !isValidAliasList(record.aliases)
  ) {
    return null;
  }

  return {
    version: 1,
    canonicalName: 'Vayria',
    displayName: 'ヴェイリア',
    aliases: [...record.aliases],
  };
}

function resolveStorage(
  storage?: CharacterIdentityStorage,
): CharacterIdentityStorage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readCharacterIdentity(
  storage?: CharacterIdentityStorage,
): CharacterIdentity {
  const target = resolveStorage(storage);
  if (!target) return cloneDefaultCharacterIdentity();

  try {
    const rawValue = target.getItem(CHARACTER_IDENTITY_STORAGE_KEY);
    if (rawValue !== null) {
      const parsed = parseCharacterIdentity(JSON.parse(rawValue) as unknown);
      if (parsed) return parsed;
    }

    const fallback = cloneDefaultCharacterIdentity();
    target.setItem(
      CHARACTER_IDENTITY_STORAGE_KEY,
      JSON.stringify(fallback),
    );
    return fallback;
  } catch {
    return cloneDefaultCharacterIdentity();
  }
}

export function writeCharacterIdentity(
  identity: CharacterIdentity,
  storage?: CharacterIdentityStorage,
): boolean {
  const parsed = parseCharacterIdentity(identity);
  const target = resolveStorage(storage);
  if (!parsed || !target) return false;

  try {
    target.setItem(CHARACTER_IDENTITY_STORAGE_KEY, JSON.stringify(parsed));
    return true;
  } catch {
    return false;
  }
}

export function addCharacterAlias(
  identity: CharacterIdentity,
  alias: string,
): CharacterIdentity | null {
  const normalizedIdentity = parseCharacterIdentity(identity);
  const normalizedAlias = normalizeAliasText(alias);
  if (!normalizedIdentity || normalizedAlias === null) return null;

  const aliasKey = normalizeNameKey(normalizedAlias);
  if (
    isSameNameKey(normalizedAlias, normalizedIdentity.canonicalName) ||
    isSameNameKey(normalizedAlias, normalizedIdentity.displayName) ||
    normalizedIdentity.aliases.some(
      (existingAlias) => normalizeNameKey(existingAlias) === aliasKey,
    ) ||
    normalizedIdentity.aliases.length >= MAX_CHARACTER_ALIAS_COUNT
  ) {
    return null;
  }

  return {
    ...normalizedIdentity,
    aliases: [...normalizedIdentity.aliases, normalizedAlias],
  };
}

const ALIAS_TOKEN_LAZY =
  '[A-Za-zＡ-Ｚａ-ｚぁ-ゖァ-ヶー\\u3400-\\u9fff]+?(?:\\s+[A-Za-zＡ-Ｚａ-ｚぁ-ゖァ-ヶー\\u3400-\\u9fff]+?)*';
const EXPLICIT_ALIAS_PATTERNS = [
  /「([^」\r\n]{1,32})」(?:と)?も呼んで/u,
  /『([^』\r\n]{1,32})』(?:と)?も呼んで/u,
  /["“]([^"”\r\n]{1,32})["”](?:と)?も呼んで/u,
  new RegExp(`(${ALIAS_TOKEN_LAZY})(?:と)?も呼んで`, 'u'),
  new RegExp(`(${ALIAS_TOKEN_LAZY})って呼んで`, 'u'),
  new RegExp(`(${ALIAS_TOKEN_LAZY})を別名として覚えて`, 'u'),
];

export function parseExplicitAliasInstruction(
  text: string,
): string | null {
  for (const pattern of EXPLICIT_ALIAS_PATTERNS) {
    const match = pattern.exec(text);
    const candidate = match?.[1];
    if (!candidate) continue;
    const normalizedCandidate = normalizeAliasText(candidate);
    if (normalizedCandidate !== null) return normalizedCandidate;
  }
  return null;
}

interface NameCandidate {
  key: string;
  match: Exclude<SelfNameMatch, 'none'>;
}

function createNameCandidates(identity: CharacterIdentity): NameCandidate[] {
  const candidates: NameCandidate[] = [];
  const seen = new Set<string>();
  const add = (value: string, match: Exclude<SelfNameMatch, 'none'>) => {
    const key = normalizeNameKey(value);
    if (!key || seen.has(key)) return;
    seen.add(key);
    candidates.push({ key, match });
  };

  add(identity.canonicalName, 'canonical');
  add(identity.displayName, 'canonical');
  for (const alias of identity.aliases) add(alias, 'alias');
  for (const form of PHONETIC_NAME_FORMS) add(form, 'phonetic');
  return candidates;
}

function isNameCharacter(character: string | undefined): boolean {
  return Boolean(character && NAME_CHAR_PATTERN.test(character));
}

function isNameLikeSpan(value: string): boolean {
  return NAME_CHAR_SEQUENCE_PATTERN.test(value);
}

function isHonorificStart(value: string): boolean {
  return /^(?:さん|ちゃん)/u.test(value);
}

function isAllowedFollowingContext(value: string): boolean {
  return (
    isHonorificStart(value) || SELF_REFERENCE_PARTICLE_PATTERN.test(value)
  );
}

function getResolution(
  match: Exclude<SelfNameMatch, 'none'>,
  matchedText: string,
  role: Exclude<SelfNameRole, 'none'>,
): SelfNameResolution {
  return {
    role,
    match,
    matchedText,
    canonicalName: 'Vayria',
    displayName: 'ヴェイリア',
  };
}

function noneResolution(): SelfNameResolution {
  return {
    role: 'none',
    match: 'none',
    matchedText: null,
    canonicalName: 'Vayria',
    displayName: 'ヴェイリア',
  };
}

function classifyNameContext(
  text: string,
  start: number,
  end: number,
): Exclude<SelfNameRole, 'none'> | null {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const afterWithoutHonorific = after.replace(HONORIFIC_PATTERN, '');
  const hasHonorific = after !== afterWithoutHonorific;
  const sentenceStart = BOUNDARY_ONLY_PATTERN.test(before);
  const sentenceEnd = BOUNDARY_ONLY_PATTERN.test(afterWithoutHonorific);
  const startsAfterBoundary = /[、,，。．.!！?？…:：;；「」『』"“”]\s*$/u.test(
    before,
  );
  const endsWithVocativePunctuation = /^[\s、,，。．.!！?？…:：;；]/u.test(
    afterWithoutHonorific,
  );
  const hasVocativePrefix = VOCATIVE_PREFIX_PATTERN.test(before);

  if (
    (sentenceStart &&
      (sentenceEnd || endsWithVocativePunctuation || hasHonorific)) ||
    (hasVocativePrefix &&
      (sentenceEnd || endsWithVocativePunctuation)) ||
    (startsAfterBoundary && sentenceEnd)
  ) {
    return 'direct_address';
  }

  if (SELF_REFERENCE_PARTICLE_PATTERN.test(afterWithoutHonorific)) {
    return 'self_reference';
  }

  return null;
}

export function resolveSelfName(
  text: string,
  identity: CharacterIdentity = DEFAULT_CHARACTER_IDENTITY,
): SelfNameResolution {
  const normalizedIdentity = parseCharacterIdentity(identity);
  if (!text || !normalizedIdentity) return noneResolution();

  const candidates = createNameCandidates(normalizedIdentity);
  const characters = Array.from(text);
  for (let start = 0; start < characters.length; start += 1) {
    if (!isNameCharacter(characters[start])) continue;
    const maxEnd = Math.min(
      characters.length,
      start + NAME_SCAN_MAX_LENGTH,
    );
    for (let end = start + 1; end <= maxEnd; end += 1) {
      if (!isNameCharacter(characters[end - 1])) continue;
      const rawCandidate = characters.slice(start, end).join('');
      if (!isNameLikeSpan(rawCandidate)) continue;

      const previousCharacter = characters[start - 1];
      const nextCharacter = characters[end];
      const nextText = characters.slice(end).join('');
      if (
        isNameCharacter(previousCharacter) ||
        (isNameCharacter(nextCharacter) &&
          !isAllowedFollowingContext(nextText))
      ) {
        continue;
      }

      const candidateKey = normalizeNameKey(rawCandidate);
      const candidate = candidates.find(({ key }) => key === candidateKey);
      if (!candidate) continue;

      const role = classifyNameContext(text, start, end);
      if (!role) continue;
      return getResolution(candidate.match, rawCandidate, role);
    }
  }

  return noneResolution();
}
