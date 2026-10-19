'use strict';
/**
 * Linko E2EE (client-side only)
 * - Identity: ECDH P-256 key pair (WebCrypto)
 * - Shared secret: ECDH with peer public key → HKDF-SHA-256 → AES-256-GCM key
 * - Every message/media blob: random IV + AES-GCM ciphertext
 * Server stores/relays ciphertext + IV only; it never has private keys.
 */
const LinkoCrypto = (() => {
  const te = new TextEncoder();
  const td = new TextDecoder();

  function b64(buf) {
    const bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function unb64(str) {
    const s = atob(str);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
  function bufToB64(buf) { return b64(buf); }
  function b64ToBuf(str) { return unb64(str).buffer; }

  async function generateIdentity() {
    const pair = await crypto.subtle.generateKey(
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      ['deriveBits']
    );
    const pub = await crypto.subtle.exportKey('spki', pair.publicKey);
    const priv = await crypto.subtle.exportKey('pkcs8', pair.privateKey);
    return {
      publicKeySpkiB64: bufToB64(pub),
      privateKeyPkcs8B64: bufToB64(priv)
    };
  }

  async function importPrivate(pkcs8b64) {
    return crypto.subtle.importKey(
      'pkcs8', b64ToBuf(pkcs8b64),
      { name: 'ECDH', namedCurve: 'P-256' },
      false,
      ['deriveBits']
    );
  }

  async function importPublic(spkib64) {
    return crypto.subtle.importKey(
      'spki', b64ToBuf(spkib64),
      { name: 'ECDH', namedCurve: 'P-256' },
      true,
      []
    );
  }

  async function deriveAesKey(privateKey, peerPublicSpkiB64) {
    const peerPub = await importPublic(peerPublicSpkiB64);
    const bits = await crypto.subtle.deriveBits(
      { name: 'ECDH', public: peerPub },
      privateKey,
      256
    );
    // HKDF-style expand with SHA-256 (single block) labeled for Linko chat
    const base = await crypto.subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: te.encode('linko-v1-salt'),
        info: te.encode('linko-chat-aes-256-gcm')
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  async function encryptBytes(aesKey, plainBytes) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, plainBytes);
    return { iv: bufToB64(iv), ciphertext: bufToB64(ct) };
  }

  async function decryptBytes(aesKey, ivB64, ctB64) {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: unb64(ivB64) },
      aesKey,
      unb64(ctB64)
    );
    return new Uint8Array(plain);
  }

  async function encryptText(aesKey, text) {
    return encryptBytes(aesKey, te.encode(text));
  }

  async function decryptText(aesKey, ivB64, ctB64) {
    const bytes = await decryptBytes(aesKey, ivB64, ctB64);
    return td.decode(bytes);
  }

  async function encryptJson(aesKey, obj) {
    return encryptText(aesKey, JSON.stringify(obj));
  }

  async function decryptJson(aesKey, ivB64, ctB64) {
    return JSON.parse(await decryptText(aesKey, ivB64, ctB64));
  }

  return {
    generateIdentity, importPrivate, importPublic, deriveAesKey,
    encryptBytes, decryptBytes, encryptText, decryptText, encryptJson, decryptJson,
    b64, unb64
  };
})();
