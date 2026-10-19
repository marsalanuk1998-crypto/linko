'use strict';
const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', 'data', 'db');
const USERS = path.join(DATA, 'users.json');
const CHATS = path.join(DATA, 'chats.json');
const MESSAGES = path.join(DATA, 'messages.json');
const INVITES = path.join(DATA, 'invites.json');
const PENDING = path.join(DATA, 'pending.json');

function ensure() {
  fs.mkdirSync(DATA, { recursive: true });
  for (const f of [USERS, CHATS, MESSAGES, INVITES, PENDING]) {
    if (!fs.existsSync(f)) fs.writeFileSync(f, '{}');
  }
}

function load(file) {
  ensure();
  try { return JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); }
  catch { return {}; }
}

function save(file, obj) {
  ensure();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
  fs.renameSync(tmp, file);
}

const db = {
  users() { return load(USERS); },
  saveUsers(u) { save(USERS, u); },
  chats() { return load(CHATS); },
  saveChats(c) { save(CHATS, c); },
  messages() { return load(MESSAGES); },
  saveMessages(m) { save(MESSAGES, m); },
  invites() { return load(INVITES); },
  saveInvites(i) { save(INVITES, i); },
  pending() { return load(PENDING); },
  savePending(p) { save(PENDING, p); },
  mediaDir() {
    const d = path.join(__dirname, '..', 'data', 'media');
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
};

module.exports = db;
