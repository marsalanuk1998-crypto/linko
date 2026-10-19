'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const SECRET_PATH = path.join(__dirname, '..', '.secret');
function secret() {
  if (!fs.existsSync(SECRET_PATH)) {
    fs.writeFileSync(SECRET_PATH, crypto.randomBytes(32).toString('hex'));
  }
  return fs.readFileSync(SECRET_PATH, 'utf8').trim();
}

/** PBKDF2-SHA256, 120k iterations — never store plaintext PIN */
function hashPin(pin, saltHex) {
  const salt = saltHex ? Buffer.from(saltHex, 'hex') : crypto.randomBytes(16);
  const hash = crypto.pbkdf2Sync(String(pin), salt, 120000, 32, 'sha256');
  return { salt: salt.toString('hex'), hash: hash.toString('hex') };
}

function verifyPin(pin, saltHex, hashHex) {
  const { hash } = hashPin(pin, saltHex);
  try {
    return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashHex, 'hex'));
  } catch { return false; }
}

const sessions = new Map(); // token -> { userId, exp }

function makeToken(userId) {
  const token = crypto.randomBytes(32).toString('base64url');
  const exp = Date.now() + 30 * 24 * 3600 * 1000; // 30 days
  sessions.set(token, { userId, exp });
  // HMAC binding so tokens survive restart when we also persist lightly
  const mac = crypto.createHmac('sha256', secret()).update(token + '|' + userId + '|' + exp).digest('base64url');
  return { token: token + '.' + mac + '.' + exp + '.' + userId, exp };
}

function parseToken(full) {
  if (!full || typeof full !== 'string') return null;
  const parts = full.split('.');
  if (parts.length !== 4) return null;
  const [token, mac, expStr, userId] = parts;
  const exp = Number(expStr);
  if (!exp || Date.now() > exp) return null;
  const expect = crypto.createHmac('sha256', secret()).update(token + '|' + userId + '|' + exp).digest('base64url');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  } catch { return null; }
  return { userId, exp, token };
}

function normalizePhone(phone) {
  return String(phone || '').replace(/[^\d+]/g, '');
}

function register({ phone, displayName, pin, publicKey }) {
  const p = normalizePhone(phone);
  if (!p || p.length < 8) throw new Error('Invalid phone number');
  if (!pin || String(pin).length < 4 || String(pin).length > 32) throw new Error('PIN must be 4–32 characters');
  if (!displayName || String(displayName).trim().length < 1) throw new Error('Display name required');
  if (!publicKey || typeof publicKey !== 'string') throw new Error('Public key required');

  const users = db.users();
  if (Object.values(users).some(u => u.phone === p)) throw new Error('Phone already registered');

  const id = 'u_' + crypto.randomBytes(8).toString('hex');
  const linkoId = 'L' + crypto.randomBytes(4).toString('hex').toUpperCase();
  const { salt, hash } = hashPin(pin);
  users[id] = {
    id, phone: p, linkoId,
    displayName: String(displayName).trim().slice(0, 40),
    pinSalt: salt, pinHash: hash,
    publicKey,
    createdAt: Date.now(),
    lastSeen: Date.now()
  };
  db.saveUsers(users);
  const sess = makeToken(id);
  return { user: publicUser(users[id]), ...sess };
}

function login({ phone, pin }) {
  const p = normalizePhone(phone);
  const users = db.users();
  const user = Object.values(users).find(u => u.phone === p);
  if (!user || !verifyPin(pin, user.pinSalt, user.pinHash)) throw new Error('Invalid phone or PIN');
  user.lastSeen = Date.now();
  db.saveUsers(users);
  const sess = makeToken(user.id);
  return { user: publicUser(user), ...sess };
}

function publicUser(u) {
  return {
    id: u.id, phone: u.phone, linkoId: u.linkoId,
    displayName: u.displayName, publicKey: u.publicKey, lastSeen: u.lastSeen
  };
}

function getUser(id) {
  const u = db.users()[id];
  return u ? publicUser(u) : null;
}

function findUsers(query) {
  const q = String(query || '').trim().toLowerCase();
  if (!q || q.length < 2) return [];
  return Object.values(db.users())
    .filter(u =>
      u.phone.includes(q) ||
      u.linkoId.toLowerCase() === q ||
      u.linkoId.toLowerCase().includes(q) ||
      u.displayName.toLowerCase().includes(q)
    )
    .slice(0, 20)
    .map(publicUser);
}

function updatePublicKey(userId, publicKey) {
  const users = db.users();
  if (!users[userId]) throw new Error('User not found');
  users[userId].publicKey = publicKey;
  db.saveUsers(users);
  return publicUser(users[userId]);
}

function touchLastSeen(userId) {
  const users = db.users();
  if (users[userId]) {
    users[userId].lastSeen = Date.now();
    db.saveUsers(users);
  }
}

module.exports = {
  register, login, parseToken, getUser, findUsers,
  updatePublicKey, touchLastSeen, publicUser, normalizePhone, hashPin, verifyPin
};
