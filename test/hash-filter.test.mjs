import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { checkPublicText, Store } from '../lib/store.mjs';

const phone = '13800138000'; // Synthetic identifier, never a real contact.
const digest = 'a'.repeat(20) + phone + 'b'.repeat(33);
const reject = value => assert.throws(() => checkPublicText(value), { code: 'POSSIBLE_PRIVATE_CONTENT' });

test('canonical SHA256 JSON fields no longer false-positive and original bytes survive', () => {
  assert.equal(digest.length, 64);
  for (const value of [
    JSON.stringify({ pair_map_sha256: digest }),
    JSON.stringify({ episodes: [{ script_sha256: digest }] }),
    JSON.stringify({ SHA256: digest.toUpperCase() }, null, 2),
  ]) assert.equal(checkPublicText(value), value);
});

test('unlabelled, unrelated and incomplete digest-shaped text retains phone screening', () => {
  for (const value of [digest, JSON.stringify(digest), JSON.stringify([digest]),
    JSON.stringify({ hash: digest }), JSON.stringify({ notsha256: digest }),
    JSON.stringify({ sha256: digest.slice(1) }), JSON.stringify({ sha256: digest + 'c' }),
    JSON.stringify({ sha256: phone }), '{"sha256":"' + digest + '",}',
    JSON.stringify({ sha256: { body: phone } }),
  ]) reject(value);
});

test('phone in another field, key, number or array is never masked by a digest', () => {
  for (const value of [
    { sha256: digest, contact: phone }, { contact: phone, sha256: digest },
    { sha256: digest, [phone]: 'synthetic' }, { sha256: digest, contact: Number(phone) },
    { sha256: digest, contacts: [phone] },
  ]) reject(JSON.stringify(value));
});

test('duplicate JSON keys preserve all original sensitive occurrences', () => {
  reject('{"contact":"' + phone + '","contact":"safe","sha256":"' + digest + '"}');
  reject('{"sha256":"' + phone + '","sha256":"' + digest + '"}');
  reject('{"sha256":"' + digest + '","sha256":"' + phone + '"}');
});

test('JSON-looking content inside a quoted string is not a digest field', () => {
  reject(JSON.stringify({ body: '"sha256":"' + digest + '"' }));
  reject(JSON.stringify({ sha256: '"sha256":"' + digest + '"' }));
});

test('secret and email screening still runs on the original JSON text', () => {
  for (const body of ['alice@example.test', 'Bearer abcdefghijklmnopqrstuvwxyz',
    'sk-abcdefghijklmnopqrstuvwxyz', 'api_key = abcdefghijklmnopqrstuvwxyz',
    'password = abcdefghijklmnopqrstuvwxyz', 'access_token = abcdefghijklmnopqrstuvwxyz']) {
    reject(JSON.stringify({ sha256: digest, body }));
  }
});

test('non-JSON public text and body validation retain existing behavior', () => {
  assert.equal(checkPublicText('Synthetic technical evidence.'), 'Synthetic technical evidence.');
  reject('Contact ' + phone);
  reject('sha256=' + digest);
  assert.throws(() => checkPublicText(''), { code: 'INVALID_BODY' });
  assert.throws(() => checkPublicText('a'.repeat(48001)), { code: 'INVALID_BODY' });
});

test('artifact screening shares the fix and SHA verification still uses original bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'bridge-hash-filter-'));
  const store = new Store(root);
  t.after(() => store.close());
  const content = JSON.stringify({ episodes: [{ script_sha256: digest }] }, null, 2);
  const sha256 = createHash('sha256').update(content).digest('hex');
  writeFileSync(join(root, 'artifacts', 'safe.json'), content);
  assert.deepEqual(store.checkArtifacts([{ path: 'safe.json', sha256 }]), [{ path: 'safe.json', sha256 }]);
  assert.throws(() => store.checkArtifacts([{ path: 'safe.json', sha256: '0'.repeat(64) }]), { code: 'ARTIFACT_HASH_MISMATCH' });
  const unsafe = JSON.stringify({ script_sha256: digest, contact: phone });
  writeFileSync(join(root, 'artifacts', 'unsafe.json'), unsafe);
  assert.throws(() => store.checkArtifacts([{ path: 'unsafe.json', sha256: createHash('sha256').update(unsafe).digest('hex') }]), { code: 'POSSIBLE_PRIVATE_CONTENT' });
});
