import assert from 'node:assert/strict';
import test from 'node:test';
import { AvatarLoadOwnership } from '../src/avatar/avatarLoadOwnership.js';

test('late, rejected, and accepted avatar results are released exactly once', () => {
  const released: object[] = [];
  const owner = new AvatarLoadOwnership<object>((value) => released.push(value));
  const missingVrm = {};
  owner.discard(missingVrm);
  owner.discard(missingVrm);
  const model = {};
  assert.equal(owner.accept(model), true);
  owner.dispose();
  owner.dispose();
  const lateModel = {};
  assert.equal(owner.accept(lateModel), false);
  assert.equal(owner.accept(lateModel), false);
  assert.equal(owner.active, false);
  assert.deepEqual(released, [missingVrm, model, lateModel]);
  const next = new AvatarLoadOwnership<object>((value) => released.push(value));
  assert.equal(next.accept({}), true);
  assert.equal(next.active, true);
});
