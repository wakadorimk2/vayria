import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addCharacterAlias,
  CHARACTER_IDENTITY_STORAGE_KEY,
  DEFAULT_CHARACTER_IDENTITY,
  parseExplicitAliasInstruction,
  readCharacterIdentity,
  resolveSelfName,
  writeCharacterIdentity,
  type CharacterIdentityStorage,
} from '../src/character/identity.js';

class MemoryStorage implements CharacterIdentityStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

test('canonical and ASR variants resolve only in name-like contexts', () => {
  assert.deepEqual(resolveSelfName('ヴェイリア', DEFAULT_CHARACTER_IDENTITY), {
    role: 'direct_address',
    match: 'canonical',
    matchedText: 'ヴェイリア',
    canonicalName: 'Vayria',
    displayName: 'ヴェイリア',
  });
  assert.equal(
    resolveSelfName('Vayria、聞こえる？', DEFAULT_CHARACTER_IDENTITY).role,
    'direct_address',
  );
  assert.equal(
    resolveSelfName('ベイリア、聞こえる？', DEFAULT_CHARACTER_IDENTITY).match,
    'phonetic',
  );
  assert.equal(
    resolveSelfName('ねえ、ウェイリア、聞こえる？', DEFAULT_CHARACTER_IDENTITY)
      .role,
    'direct_address',
  );
  assert.equal(
    resolveSelfName('ヴェイリアはどう思う？', DEFAULT_CHARACTER_IDENTITY).role,
    'self_reference',
  );
  assert.equal(
    resolveSelfName('バイリアが好き？', DEFAULT_CHARACTER_IDENTITY).role,
    'self_reference',
  );
  assert.equal(
    resolveSelfName('今日はVayriaXを調べた', DEFAULT_CHARACTER_IDENTITY).role,
    'none',
  );
  assert.equal(
    resolveSelfName('プロジェクトVayriaの名前', DEFAULT_CHARACTER_IDENTITY)
      .role,
    'none',
  );
  assert.equal(
    resolveSelfName('聞こえる Vayria', DEFAULT_CHARACTER_IDENTITY).role,
    'none',
  );
});

test('resolution preserves the matched ASR text and does not rewrite input', () => {
  const message = 'ねえ、ウェイリア';
  const resolution = resolveSelfName(message, DEFAULT_CHARACTER_IDENTITY);

  assert.equal(resolution.role, 'direct_address');
  assert.equal(resolution.match, 'phonetic');
  assert.equal(resolution.matchedText, 'ウェイリア');
  assert.equal(message, 'ねえ、ウェイリア');
});

test('explicit alias phrases parse and ordinary text does not teach aliases', () => {
  assert.equal(parseExplicitAliasInstruction('ベイリアとも呼んで'), 'ベイリア');
  assert.equal(
    parseExplicitAliasInstruction('「ベイリア」とも呼んで'),
    'ベイリア',
  );
  assert.equal(parseExplicitAliasInstruction('ベイリアって呼んで'), 'ベイリア');
  assert.equal(
    parseExplicitAliasInstruction('ベイリアを別名として覚えて'),
    'ベイリア',
  );
  assert.equal(parseExplicitAliasInstruction('今日はベイリアの話'), null);
  assert.equal(DEFAULT_CHARACTER_IDENTITY.aliases.length, 0);
});

test('explicit aliases persist and resolve after reload', () => {
  const storage = new MemoryStorage();
  const firstRead = readCharacterIdentity(storage);
  assert.deepEqual(firstRead, DEFAULT_CHARACTER_IDENTITY);
  assert.ok(storage.getItem(CHARACTER_IDENTITY_STORAGE_KEY));

  const withAlias = addCharacterAlias(firstRead, 'ベイリア');
  assert.ok(withAlias);
  assert.equal(writeCharacterIdentity(withAlias!, storage), true);

  const reloaded = readCharacterIdentity(storage);
  assert.deepEqual(reloaded.aliases, ['ベイリア']);
  assert.equal(
    resolveSelfName('ベイリア、聞こえる？', reloaded).match,
    'alias',
  );
});

test('invalid stored identities and invalid aliases fall back safely', () => {
  const storage = new MemoryStorage();
  storage.setItem(
    CHARACTER_IDENTITY_STORAGE_KEY,
    JSON.stringify({ version: 1, canonicalName: 'Other', aliases: [] }),
  );
  assert.deepEqual(readCharacterIdentity(storage), DEFAULT_CHARACTER_IDENTITY);
  assert.equal(
    addCharacterAlias(
      DEFAULT_CHARACTER_IDENTITY,
      'これは長すぎる名前なので保存してはいけませんわ'.repeat(2),
    ),
    null,
  );
  assert.equal(addCharacterAlias(DEFAULT_CHARACTER_IDENTITY, '「ベイリア」'), null);
  assert.equal(addCharacterAlias(DEFAULT_CHARACTER_IDENTITY, 'Vayria'), null);
});
