'use strict';
/** Node WebCrypto E2EE round-trip mirroring web/js/crypto.js */
const { webcrypto } = require('crypto');
const crypto = webcrypto;
const te = new TextEncoder();
const td = new TextDecoder();

function b64(buf) {
  return Buffer.from(buf).toString('base64');
}
function unb64(str) {
  return Buffer.from(str, 'base64');
}

async function generateIdentity() {
  const pair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const pub = await crypto.subtle.exportKey('spki', pair.publicKey);
  const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
  return { pair, publicKeySpkiB64: b64(pub), privateKeyPkcs8B64: b64(priv) };
}

async function importPrivate(b) {
  return crypto.subtle.importKey('pkcs8', unb64(b), { name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits']);
}
async function importPublic(b) {
  return crypto.subtle.importKey('spki', unb64(b), { name: 'ECDH', namedCurve: 'P-256' }, true, []);
}

async function deriveAes(priv, peerPubB64) {
  const peerPub = await importPublic(peerPubB64);
  const bits = await crypto.subtle.deriveBits({ name: 'ECDH', public: peerPub }, priv, 256);
  const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: te.encode('linko-v1-salt'), info: te.encode('linko-chat-aes-256-gcm') },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']
  );
}

(async () => {
  const A = await generateIdentity();
  const B = await generateIdentity();
  const aPriv = await importPrivate(A.privateKeyPkcs8B64);
  const bPriv = await importPrivate(B.privateKeyPkcs8B64);
  const keyA = await deriveAes(aPriv, B.publicKeySpkiB64);
  const keyB = await deriveAes(bPriv, A.publicKeySpkiB64);

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = te.encode('Hello from Linko E2EE');
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, keyA, plain);
  const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyB, ct);
  const text = td.decode(out);
  const pass = text === 'Hello from Linko E2EE';
  // Server-blind: ciphertext alone is not plaintext
  const ctStr = Buffer.from(ct).toString('utf8');
  const blind = !ctStr.includes('Hello from Linko');
  console.log(pass && blind ? 'PASS e2ee-roundtrip' : 'FAIL e2ee-roundtrip', JSON.stringify({ text, blind }));
  // Wrong peer cannot decrypt
  const C = await generateIdentity();
  const cPriv = await importPrivate(C.privateKeyPkcs8B64);
  const keyC = await deriveAes(cPriv, A.publicKeySpkiB64);
  let rejected = false;
  try { await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, keyC, ct); }
  catch { rejected = true; }
  console.log(rejected ? 'PASS e2ee-wrong-peer-rejected' : 'FAIL e2ee-wrong-peer-rejected');
  process.exit(pass && blind && rejected ? 0 : 1);
})();
