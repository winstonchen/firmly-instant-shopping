// Card encryption: JWE compact serialization, RSA-OAEP-256 + A256GCM, built
// on WebCrypto only (no third-party crypto) so the same file runs in the
// extension and in Node. Card data never leaves the device unencrypted; the
// ciphertext is only decryptable by Firmly's PCI-scoped payment service.

const te = new TextEncoder();

function b64url(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < arr.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, arr.subarray(i, i + CHUNK));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Encrypt a card object with Firmly's public key.
 *
 * @param {object} card  { number, name, verification_value, month, year } — all strings.
 * @param {object} jwk   RSA public JWK from GET {paymentBase}/api/v1/payment/key
 * @param {string} kid   Key id from the `x-firmly-kid` response header
 * @returns {Promise<string>} JWE compact token for `complete-order.encrypted_card`
 */
export async function encryptCardJWE(card, jwk, kid) {
  const header = { alg: 'RSA-OAEP-256', enc: 'A256GCM', kid };
  const protectedB64 = b64url(te.encode(JSON.stringify(header)));

  // Content-encryption key, wrapped with the merchant public key.
  const cek = crypto.getRandomValues(new Uint8Array(32));
  const rsaKey = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e },
    { name: 'RSA-OAEP', hash: 'SHA-256' },
    false,
    ['encrypt']
  );
  const encryptedKey = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsaKey, cek);

  // AES-256-GCM over the payload; the protected header is the AAD.
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: te.encode(protectedB64), tagLength: 128 },
      aesKey,
      te.encode(JSON.stringify(card))
    )
  );
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);

  return [protectedB64, b64url(encryptedKey), b64url(iv), b64url(ciphertext), b64url(tag)].join('.');
}
