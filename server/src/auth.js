'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('./db');
const mailer = require('./mailer');
const whatsapp = require('./whatsapp');

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

// ---- Invites: stop strangers from claiming someone else's phone number ----
// SMS OTP is paid, so phone numbers are NOT verified. Instead registration is
// invite-only: an existing user generates a one-time code (optionally locked to
// the friend's phone number) and shares it out-of-band.
const INVITE_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_ACTIVE_INVITES = 20;
const INVITE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

function normalizeInvite(code) {
  return String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function newInviteCode() {
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 10; i++) out += INVITE_ALPHABET[bytes[i] % INVITE_ALPHABET.length];
  return out; // ~50 bits
}

function formatInvite(code) { return code.slice(0, 5) + '-' + code.slice(5); }

function createInvite(userId, { phone } = {}) {
  const users = db.users();
  if (!users[userId]) throw new Error('User not found');
  const lockPhone = phone ? normalizePhone(phone) : null;
  if (lockPhone && lockPhone.length < 8) throw new Error('Invalid phone number for invite');
  if (lockPhone && Object.values(users).some(u => u.phone === lockPhone)) throw new Error('That phone is already registered');
  const invites = db.invites();
  const now = Date.now();
  // prune expired
  for (const [k, v] of Object.entries(invites)) if (!v.usedAt && v.exp < now) delete invites[k];
  const active = Object.values(invites).filter(v => v.createdBy === userId && !v.usedAt).length;
  if (active >= MAX_ACTIVE_INVITES) throw new Error('Too many unused invites — wait for some to be used or expire');
  let code;
  do { code = newInviteCode(); } while (invites[code]);
  invites[code] = { code, createdBy: userId, phone: lockPhone, createdAt: now, exp: now + INVITE_TTL_MS, usedBy: null, usedAt: null };
  db.saveInvites(invites);
  return { code: formatInvite(code), phone: lockPhone, exp: invites[code].exp };
}

function listInvites(userId) {
  const now = Date.now();
  return Object.values(db.invites())
    .filter(v => v.createdBy === userId && (v.usedAt || v.exp > now))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 50)
    .map(v => ({ code: formatInvite(v.code), phone: v.phone, exp: v.exp, used: !!v.usedAt, usedAt: v.usedAt }));
}

function bootstrapMode() {
  return Object.keys(db.users()).length === 0;
}

// ---- Brute-force protection for PIN login (in-memory) ----
const failures = new Map(); // key -> { count, until }
const MAX_FAILS = 5;
const LOCK_MS = 15 * 60 * 1000;
function checkLock(key) {
  const f = failures.get(key);
  if (f && f.until && Date.now() < f.until) {
    const mins = Math.ceil((f.until - Date.now()) / 60000);
    throw new Error(`Too many attempts — try again in ${mins} min`);
  }
}
function noteFail(key) {
  const f = failures.get(key) || { count: 0, until: 0 };
  if (f.until && Date.now() >= f.until) { f.count = 0; f.until = 0; }
  f.count++;
  if (f.count >= MAX_FAILS) f.until = Date.now() + LOCK_MS;
  failures.set(key, f);
}
function clearFail(key) { failures.delete(key); }

// ---- Email OTP (ownership of the EMAIL address; phone stays unverified) ----
const OTP_TTL_MS = 10 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_MS = Number(process.env.LINKO_OTP_RESEND_SECONDS || 60) * 1000;
const OTP_MAX_PER_HOUR = 5;
const sendLog = new Map(); // key -> [timestamps]

function normalizeEmail(e) { return String(e || '').trim().toLowerCase(); }
function validEmail(e) { return /^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/i.test(e) && e.length <= 254; }
function maskEmail(e) {
  const [u, d] = String(e).split('@');
  if (!d) return '';
  return (u.length <= 2 ? u[0] + '*' : u.slice(0, 2) + '***' + u.slice(-1)) + '@' + d;
}
function otpHash(id, code) { return crypto.createHmac('sha256', secret()).update(id + '|' + code).digest('hex'); }
function rateSend(key) {
  const now = Date.now();
  const arr = (sendLog.get(key) || []).filter(t => now - t < 3600 * 1000);
  if (arr.length && now - arr[arr.length - 1] < OTP_RESEND_MS) throw new Error('Please wait a minute before requesting another code');
  if (arr.length >= OTP_MAX_PER_HOUR) throw new Error('Too many codes requested — try again in an hour');
  arr.push(now); sendLog.set(key, arr);
}
function emailOtpEnabled() { return mailer.configured(); }
function waOtpEnabled() { return whatsapp.configured(); }
function otpChannels() { return [waOtpEnabled() && 'whatsapp', emailOtpEnabled() && 'email'].filter(Boolean); }
function anyOtp() { return otpChannels().length > 0; }
/**
 * Invite policy:
 *  - No OTP channel configured           → invite required (only defence against number squatting)
 *  - WhatsApp OTP to the phone itself    → proves the number → no invite needed
 *  - Email OTP                           → proves the email only, NOT the phone → invite still
 *                                          required unless LINKO_EMAIL_SIGNUP_NO_INVITE=1
 *  - LINKO_REQUIRE_INVITE=1 forces invites for everyone.
 */
function inviteRequired(channel) {
  if (bootstrapMode()) return !!process.env.LINKO_BOOTSTRAP_INVITE;
  if (process.env.LINKO_REQUIRE_INVITE === '1') return true;
  if (!anyOtp()) return true;
  if (channel === 'whatsapp') return false;
  if (channel === 'email') return process.env.LINKO_EMAIL_SIGNUP_NO_INVITE !== '1';
  // unknown channel: required unless every available channel waives it
  return !otpChannels().some(c => !inviteRequired(c));
}
function pickChannel(requested, { email, emailVerified, allowEmailUnverified } = {}) {
  const ch = otpChannels();
  const emailOk = ch.includes('email') && email && (emailVerified || allowEmailUnverified);
  const waOk = ch.includes('whatsapp');
  if (requested === 'email' && emailOk) return 'email';
  if (requested === 'whatsapp' && waOk) return 'whatsapp';
  if (requested === 'email' && !emailOk) throw new Error(!ch.includes('email') ? 'Email codes are not set up on this server' : (allowEmailUnverified ? 'Enter your email address first' : 'No verified email on this account — use WhatsApp'));
  if (requested === 'whatsapp' && !waOk) throw new Error('WhatsApp codes are not set up on this server — use email');
  return waOk ? 'whatsapp' : (emailOk ? 'email' : null);
}
function maskPhone(p) { const d = String(p).replace(/\D/g, ''); return '+' + d.slice(0, 2) + '******' + d.slice(-3); }

async function createPending(kind, channel, dest, data) {
  rateSend(channel + ':' + dest);
  const pend = db.pending();
  const now = Date.now();
  for (const [k, v] of Object.entries(pend)) if (v.exp < now) delete pend[k];
  const id = 'p_' + crypto.randomBytes(12).toString('hex');
  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  pend[id] = { id, kind, channel, dest, data, otp: otpHash(id, code), exp: now + OTP_TTL_MS, attempts: 0 };
  db.savePending(pend);
  try {
    if (channel === 'whatsapp') await whatsapp.sendOtp(dest, code);
    else await mailer.sendOtp(dest, code, kind);
  } catch (e) { const p2 = db.pending(); delete p2[id]; db.savePending(p2); throw e; }
  const sentTo = channel === 'whatsapp' ? 'WhatsApp ' + maskPhone(dest) : maskEmail(dest);
  return { ticket: id, channel, sentTo, emailHint: sentTo, expiresIn: OTP_TTL_MS / 1000, channels: otpChannels() };
}

function consumePending(ticket, code, kind) {
  const pend = db.pending();
  const p = pend[String(ticket || '')];
  if (!p || p.kind !== kind || p.exp < Date.now()) throw new Error('Code expired — request a new one');
  p.attempts++;
  const ok = (() => { try { return crypto.timingSafeEqual(Buffer.from(p.otp, 'hex'), Buffer.from(otpHash(p.id, String(code || '').replace(/\D/g, '')), 'hex')); } catch { return false; } })();
  if (!ok) {
    if (p.attempts >= OTP_MAX_ATTEMPTS) { delete pend[p.id]; db.savePending(pend); throw new Error('Too many wrong codes — request a new one'); }
    db.savePending(pend);
    throw new Error(`Wrong code (${OTP_MAX_ATTEMPTS - p.attempts} tries left)`);
  }
  delete pend[p.id];
  db.savePending(pend);
  return p;
}

function hashDevice(deviceId) {
  return crypto.createHmac('sha256', secret()).update('dev|' + String(deviceId || '')).digest('hex').slice(0, 32);
}
function validDevice(deviceId) { return typeof deviceId === 'string' && deviceId.length >= 16 && deviceId.length <= 128; }

function checkInvite(users, invites, code, p, ipKey, channel) {
  if (Object.keys(users).length === 0) {
    const boot = normalizeInvite(process.env.LINKO_BOOTSTRAP_INVITE || '');
    if (boot && code !== boot) { noteFail(ipKey); throw new Error('Setup invite code required for the first account'); }
    return null;
  }
  if (!inviteRequired(channel)) return null;
  if (!code) throw new Error('Invite code required — ask a friend on Linko to tap "Invite friend"');
  const invite = invites[code];
  if (!invite || invite.usedAt || invite.exp < Date.now()) { noteFail(ipKey); throw new Error('Invalid or expired invite code'); }
  if (invite.phone && invite.phone !== p) { noteFail(ipKey); throw new Error('This invite is for a different phone number'); }
  return invite;
}

function validateRegistration({ phone, displayName, pin, publicKey, email }) {
  const p = normalizePhone(phone);
  if (!p || p.replace(/\D/g, '').length < 8) throw new Error('Invalid phone number');
  if (!pin || String(pin).length < 4 || String(pin).length > 32) throw new Error('PIN must be 4–32 characters (6+ recommended)');
  if (!displayName || String(displayName).trim().length < 1) throw new Error('Display name required');
  if (!publicKey || typeof publicKey !== 'string' || publicKey.length > 2000) throw new Error('Public key required');
  const em = normalizeEmail(email);
  if (em && !validEmail(em)) throw new Error('Invalid email');
  return { p, em };
}

function createUser(users, { p, em, displayName, pinSalt, pinHash, publicKey, invite, deviceId, emailVerified }) {
  if (Object.values(users).some(u => u.phone === p)) throw new Error('Phone already registered');
  if (em && Object.values(users).some(u => u.email === em)) throw new Error('Email already used by another account');
  const id = 'u_' + crypto.randomBytes(8).toString('hex');
  const linkoId = 'L' + crypto.randomBytes(4).toString('hex').toUpperCase();
  users[id] = {
    id, phone: p, linkoId,
    displayName: String(displayName).trim().slice(0, 40),
    email: em || null, emailVerified: !!emailVerified,
    pinSalt, pinHash, publicKey,
    devices: validDevice(deviceId) ? [hashDevice(deviceId)] : [],
    invitedBy: invite ? invite.createdBy : null,
    createdAt: Date.now(), lastSeen: Date.now()
  };
  return users[id];
}

/** Step 1. With email OTP on: returns { otpRequired, ticket, emailHint }. Otherwise creates account directly. */
async function register(body, meta = {}) {
  const { displayName, pin, publicKey, inviteCode, deviceId } = body;
  const { p, em } = validateRegistration(body);
  const channel = anyOtp() ? pickChannel(body.channel, { email: em, allowEmailUnverified: true }) : null;
  if (anyOtp() && !channel) throw new Error('Enter your email to receive the code');
  const ipKey = 'reg:' + (meta.ip || '?');
  checkLock(ipKey);
  const users = db.users();
  const invites = db.invites();
  const code = normalizeInvite(inviteCode);
  const invite = checkInvite(users, invites, code, p, ipKey, channel);
  if (Object.values(users).some(u => u.phone === p)) throw new Error('Phone already registered');
  if (em && Object.values(users).some(u => u.email === em)) throw new Error('Email already used by another account');
  const { salt, hash } = hashPin(pin);

  if (channel) {
    const out = await createPending('register', channel, channel === 'whatsapp' ? p : em, {
      channel, p, em, displayName, pinSalt: salt, pinHash: hash, publicKey,
      inviteCode: invite ? invite.code : null, deviceId: validDevice(deviceId) ? deviceId : null
    });
    return { otpRequired: true, ...out };
  }

  const user = createUser(users, { p, em, displayName, pinSalt: salt, pinHash: hash, publicKey, invite, deviceId, emailVerified: false });
  db.saveUsers(users);
  if (invite) { invite.usedBy = user.id; invite.usedAt = Date.now(); db.saveInvites(invites); }
  clearFail(ipKey);
  return { user: publicUser(user), ...makeToken(user.id) };
}

/** Step 2: verify the emailed code → account becomes active. */
function verifyRegistration({ ticket, otp }) {
  const pend = consumePending(ticket, otp, 'register');
  const d = pend.data;
  const users = db.users();
  const invites = db.invites();
  let invite = null;
  if (d.inviteCode) {
    invite = invites[d.inviteCode];
    if (!invite || invite.usedAt) throw new Error('Invite code was already used — ask for a new one');
  }
  const user = createUser(users, { ...d, invite, emailVerified: d.channel === 'email' });
  if (d.channel === 'whatsapp') user.phoneVerified = true;
  db.saveUsers(users);
  if (invite) { invite.usedBy = user.id; invite.usedAt = Date.now(); db.saveInvites(invites); }
  return { user: publicUser(user), ...makeToken(user.id) };
}

function checkPin(phone, pin, meta) {
  const p = normalizePhone(phone);
  const phoneKey = 'login:' + p;
  const ipKey = 'loginip:' + (meta.ip || '?');
  checkLock(phoneKey);
  checkLock(ipKey);
  const users = db.users();
  const user = Object.values(users).find(u => u.phone === p);
  if (!user || !verifyPin(pin, user.pinSalt, user.pinHash)) {
    noteFail(phoneKey);
    const f = failures.get(ipKey) || { count: 0, until: 0 };
    f.count++; if (f.count >= MAX_FAILS * 4) f.until = Date.now() + LOCK_MS;
    failures.set(ipKey, f);
    throw new Error('Invalid phone or PIN');
  }
  clearFail(phoneKey);
  return { users, user };
}

/** Phone + PIN. On a NEW device (and when the account has a verified email) an email code is also required. */
async function login({ phone, pin, deviceId, channel }, meta = {}) {
  const { users, user } = checkPin(phone, pin, meta);
  const dh = validDevice(deviceId) ? hashDevice(deviceId) : null;
  const known = dh && (user.devices || []).includes(dh);
  // New device → second factor via WhatsApp (to the account phone) or the verified email.
  // Legacy accounts (created before OTP) with no verified channel keep PIN-only until they verify.
  const verifiedAccount = user.phoneVerified || user.emailVerified;
  if (!known && verifiedAccount && anyOtp()) {
    const ch = pickChannel(channel, { email: user.email, emailVerified: user.emailVerified });
    if (ch) {
      const out = await createPending('login', ch, ch === 'whatsapp' ? user.phone : user.email, { userId: user.id, deviceId: validDevice(deviceId) ? deviceId : null, channel: ch });
      return { otpRequired: true, ...out };
    }
  }
  if (dh && !known) { user.devices = [...(user.devices || []), dh].slice(-10); }
  user.lastSeen = Date.now();
  db.saveUsers(users);
  return { user: publicUser(user), ...makeToken(user.id) };
}

function verifyLogin({ ticket, otp }) {
  const pend = consumePending(ticket, otp, 'login');
  const users = db.users();
  const user = users[pend.data.userId];
  if (!user) throw new Error('User not found');
  if (pend.data.deviceId) user.devices = [...new Set([...(user.devices || []), hashDevice(pend.data.deviceId)])].slice(-10);
  if (pend.data.channel === 'whatsapp') user.phoneVerified = true;
  user.lastSeen = Date.now();
  db.saveUsers(users);
  return { user: publicUser(user), ...makeToken(user.id) };
}

/** Forgot PIN: code goes to the account's verified email. Response is the same whether or not the phone exists. */
async function requestPinReset({ phone, channel }) {
  const p = normalizePhone(phone);
  const user = Object.values(db.users()).find(u => u.phone === p);
  if (!anyOtp()) throw new Error('PIN reset needs email or WhatsApp codes to be set up on the server');
  let ch = null;
  try { ch = user ? pickChannel(channel, { email: user.email, emailVerified: user.emailVerified }) : null; } catch { ch = null; }
  if (!user || !ch) {
    // Same-shaped answer so the endpoint can't be used to discover who is registered.
    return { otpRequired: true, ticket: 'p_' + crypto.randomBytes(12).toString('hex'), sentTo: 'your account', emailHint: 'your account', expiresIn: OTP_TTL_MS / 1000, channels: otpChannels() };
  }
  const out = await createPending('reset', ch, ch === 'whatsapp' ? user.phone : user.email, { userId: user.id, channel: ch });
  return { otpRequired: true, ...out };
}

function verifyPinReset({ ticket, otp, newPin, deviceId }) {
  if (!newPin || String(newPin).length < 4 || String(newPin).length > 32) throw new Error('PIN must be 4–32 characters (6+ recommended)');
  const pend = consumePending(ticket, otp, 'reset');
  const users = db.users();
  const user = users[pend.data.userId];
  if (!user) throw new Error('User not found');
  const { salt, hash } = hashPin(newPin);
  user.pinSalt = salt; user.pinHash = hash;
  user.devices = validDevice(deviceId) ? [hashDevice(deviceId)] : [];
  db.saveUsers(users);
  return { user: publicUser(user), ...makeToken(user.id) };
}

function publicUser(u) {
  return {
    id: u.id, phone: u.phone, linkoId: u.linkoId,
    displayName: u.displayName, publicKey: u.publicKey, lastSeen: u.lastSeen,
    emailVerified: !!u.emailVerified, phoneVerified: !!u.phoneVerified
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
      (u.phone || '').includes(q) ||
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
  updatePublicKey, touchLastSeen, publicUser, normalizePhone, hashPin, verifyPin,
  createInvite, listInvites, bootstrapMode,
  verifyRegistration, verifyLogin, requestPinReset, verifyPinReset, emailOtpEnabled, waOtpEnabled, otpChannels, inviteRequired
};
