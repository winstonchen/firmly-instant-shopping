// Roundtrip tests for lib/jwe.js — encrypt with a locally generated RSA key,
// then decrypt in Node and verify the JWE compact structure end to end
// (RSA-OAEP-256 key wrap, A256GCM content encryption, header as AAD).
import test from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { encryptCardJWE } from '../../extension/lib/jwe.js';

const td = new TextDecoder();
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const CARD = { number: '4111111111111111', name: 'Sam Browser', verification_value: '123', month: '12', year: '2030' };

async function makeKeyPair() {
  return webcrypto.subtle.generateKey(
    { name: 'RSA-OAEP', hash: 'SHA-256', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['encrypt', 'decrypt']
  );
}

test('encryptCardJWE: produces a 5-part compact JWE with the right protected header', async () => {
  const { publicKey } = await makeKeyPair();
  const jwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const token = await encryptCardJWE(CARD, jwk, 'kid-42');
  const parts = token.split('.');
  assert.equal(parts.length, 5);
  assert.match(token, /^[A-Za-z0-9_.-]+$/); // base64url only, no padding
  const header = JSON.parse(td.decode(b64urlDecode(parts[0])));
  assert.deepEqual(header, { alg: 'RSA-OAEP-256', enc: 'A256GCM', kid: 'kid-42' });
});

test('encryptCardJWE: decrypts back to the exact card object (full roundtrip)', async () => {
  const { publicKey, privateKey } = await makeKeyPair();
  const jwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const token = await encryptCardJWE(CARD, jwk, 'kid-1');
  const [h, ek, iv, ct, tag] = token.split('.').map(b64urlDecode);

  const cek = await webcrypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, ek);
  assert.equal(cek.byteLength, 32); // AES-256 CEK
  const aesKey = await webcrypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['decrypt']);
  const plaintext = await webcrypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv,
      additionalData: new TextEncoder().encode(token.split('.')[0]),
      tagLength: 128
    },
    aesKey,
    Buffer.concat([ct, tag])
  );
  assert.deepEqual(JSON.parse(td.decode(plaintext)), CARD);
});

test('encryptCardJWE: fresh CEK + IV per call (tokens never repeat)', async () => {
  const { publicKey } = await makeKeyPair();
  const jwk = await webcrypto.subtle.exportKey('jwk', publicKey);
  const t1 = await encryptCardJWE(CARD, jwk, 'kid-1');
  const t2 = await encryptCardJWE(CARD, jwk, 'kid-1');
  assert.notEqual(t1, t2);
  assert.notEqual(t1.split('.')[2], t2.split('.')[2]); // distinct IVs
});
