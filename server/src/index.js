'use strict';
/**
 * Linko server — free-tier friendly.
 * - REST: register / login / search / media upload(relay of ciphertext)
 * - WebSocket: chat ciphertext relay, presence, typing, WebRTC signaling
 * Server NEVER sees plaintext message bodies or call media (DTLS-SRTP peer-to-peer).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const db = require('./db');
const auth = require('./auth');

const PORT = Number(process.env.PORT || process.env.LINKO_PORT || 8787);
const HOST = process.env.LINKO_HOST || '0.0.0.0';
const WEB_ROOT = process.env.LINKO_WEB_ROOT || path.join(__dirname, '..', '..', 'web');

const online = new Map(); // userId -> Set of ws
const sockets = new WeakMap(); // ws -> { userId }

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Content-Length': Buffer.byteLength(body)
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > 12 * 1024 * 1024) { reject(new Error('Body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.socket.remoteAddress || '?';
}

function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function requireUser(req) {
  const t = auth.parseToken(bearer(req));
  if (!t) return null;
  return auth.getUser(t.userId);
}

function chatIdFor(a, b) {
  return [a, b].sort().join(':');
}

function ensureChat(a, b) {
  const chats = db.chats();
  const id = chatIdFor(a, b);
  if (!chats[id]) {
    chats[id] = { id, members: [a, b].sort(), createdAt: Date.now(), updatedAt: Date.now() };
    db.saveChats(chats);
  }
  return chats[id];
}

function storeMessage(msg) {
  const all = db.messages();
  if (!all[msg.chatId]) all[msg.chatId] = [];
  all[msg.chatId].push(msg);
  // keep last 2000 per chat
  if (all[msg.chatId].length > 2000) all[msg.chatId] = all[msg.chatId].slice(-2000);
  db.saveMessages(all);
  const chats = db.chats();
  if (chats[msg.chatId]) {
    chats[msg.chatId].updatedAt = Date.now();
    db.saveChats(chats);
  }
  return msg;
}

function mimeOf(p) {
  const ext = path.extname(p).toLowerCase();
  return ({
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp',
    '.woff2': 'font/woff2',
    '.json': 'application/json',
    '.ico': 'image/x-icon'
  })[ext] || 'application/octet-stream';
}

function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]);
  if (rel === '/' || rel === '') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const file = path.join(WEB_ROOT, safe);
  if (!file.startsWith(WEB_ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('Not found'); return;
  }
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': mimeOf(file),
    'Cache-Control': rel.includes('/vendor/') ? 'public, max-age=86400' : 'no-cache',
    'Access-Control-Allow-Origin': '*'
  });
  res.end(data);
}

async function handleApi(req, res, pathname) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
    });
    return res.end();
  }

  try {
    if (pathname === '/api/health' && req.method === 'GET') {
      return json(res, 200, { ok: true, name: 'Linko', version: '1.2.0', otpChannels: auth.otpChannels(), ts: Date.now() });
    }

    if (pathname === '/api/register' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const out = await auth.register(body, { ip: clientIp(req) });
      return json(res, out.otpRequired ? 202 : 201, out);
    }

    if (pathname === '/api/register/verify' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 201, auth.verifyRegistration(body));
    }

    if (pathname === '/api/login/verify' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 200, auth.verifyLogin(body));
    }

    if (pathname === '/api/pin-reset' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 202, await auth.requestPinReset(body));
    }

    if (pathname === '/api/pin-reset/verify' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 200, auth.verifyPinReset(body));
    }

    if (pathname === '/api/login' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const out = await auth.login(body, { ip: clientIp(req) });
      return json(res, out.otpRequired ? 202 : 200, out);
    }

    if (pathname === '/api/auth-info' && req.method === 'GET') {
      return json(res, 200, {
        channels: auth.otpChannels(),
        emailOtp: auth.emailOtpEnabled(), whatsappOtp: auth.waOtpEnabled(),
        inviteRequired: { email: auth.inviteRequired('email'), whatsapp: auth.inviteRequired('whatsapp'), none: auth.inviteRequired(null) },
        bootstrap: auth.bootstrapMode()
      });
    }

    if (pathname === '/api/invites' && req.method === 'POST') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      return json(res, 201, { invite: auth.createInvite(u.id, { phone: body.phone }) });
    }

    if (pathname === '/api/invites' && req.method === 'GET') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { invites: auth.listInvites(u.id) });
    }

    if (pathname === '/api/me' && req.method === 'GET') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      return json(res, 200, { user: u });
    }

    if (pathname === '/api/keys' && req.method === 'POST') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
      const updated = auth.updatePublicKey(u.id, body.publicKey);
      return json(res, 200, { user: updated });
    }

    if (pathname === '/api/search' && req.method === 'GET') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const q = new URL(req.url, 'http://x').searchParams.get('q') || '';
      return json(res, 200, { users: auth.findUsers(q).filter(x => x.id !== u.id) });
    }

    if (pathname === '/api/users/' || pathname.startsWith('/api/users/')) {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const id = pathname.slice('/api/users/'.length);
      const found = auth.getUser(id);
      if (!found) return json(res, 404, { error: 'Not found' });
      return json(res, 200, { user: found });
    }

    if (pathname === '/api/chats' && req.method === 'GET') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const chats = Object.values(db.chats())
        .filter(c => c.members.includes(u.id))
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map(c => {
          const otherId = c.members.find(m => m !== u.id);
          const msgs = (db.messages()[c.id] || []);
          const last = msgs[msgs.length - 1] || null;
          return {
            id: c.id,
            peer: auth.getUser(otherId),
            updatedAt: c.updatedAt,
            lastMessage: last ? { id: last.id, type: last.type, createdAt: last.createdAt, from: last.from } : null
          };
        });
      return json(res, 200, { chats });
    }

    if (pathname.startsWith('/api/chats/') && pathname.endsWith('/messages') && req.method === 'GET') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const chatId = pathname.slice('/api/chats/'.length, -'/messages'.length);
      const chat = db.chats()[chatId];
      if (!chat || !chat.members.includes(u.id)) return json(res, 404, { error: 'Not found' });
      const msgs = db.messages()[chatId] || [];
      return json(res, 200, { messages: msgs.slice(-200) });
    }

    if (pathname === '/api/media' && req.method === 'POST') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const buf = await readBody(req);
      const id = crypto.randomBytes(16).toString('hex');
      const file = path.join(db.mediaDir(), id + '.bin');
      fs.writeFileSync(file, buf);
      return json(res, 201, { mediaId: id, size: buf.length });
    }

    if (pathname.startsWith('/api/media/') && req.method === 'GET') {
      const u = requireUser(req);
      if (!u) return json(res, 401, { error: 'Unauthorized' });
      const id = pathname.slice('/api/media/'.length).replace(/[^a-f0-9]/gi, '');
      const file = path.join(db.mediaDir(), id + '.bin');
      if (!fs.existsSync(file)) return json(res, 404, { error: 'Not found' });
      const data = fs.readFileSync(file);
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
        'Content-Length': data.length
      });
      return res.end(data);
    }

    return json(res, 404, { error: 'Not found' });
  } catch (e) {
    return json(res, 400, { error: e.message || 'Bad request' });
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url.pathname);
  return serveStatic(req, res, url.pathname);
});

const wss = new WebSocketServer({ server, path: '/ws' });

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function broadcastToUser(userId, obj, exceptWs) {
  const set = online.get(userId);
  if (!set) return;
  for (const ws of set) {
    if (ws !== exceptWs) send(ws, obj);
  }
}

function setOnline(userId, ws) {
  if (!online.has(userId)) online.set(userId, new Set());
  online.get(userId).add(ws);
  sockets.set(ws, { userId });
  auth.touchLastSeen(userId);
  // notify contacts who share a chat
  const chats = Object.values(db.chats()).filter(c => c.members.includes(userId));
  for (const c of chats) {
    const other = c.members.find(m => m !== userId);
    broadcastToUser(other, { type: 'presence', userId, online: true, lastSeen: Date.now() });
  }
}

function setOffline(ws) {
  const meta = sockets.get(ws);
  if (!meta) return;
  const { userId } = meta;
  const set = online.get(userId);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      online.delete(userId);
      auth.touchLastSeen(userId);
      const lastSeen = Date.now();
      const chats = Object.values(db.chats()).filter(c => c.members.includes(userId));
      for (const c of chats) {
        const other = c.members.find(m => m !== userId);
        broadcastToUser(other, { type: 'presence', userId, online: false, lastSeen });
      }
    }
  }
}

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const token = url.searchParams.get('token');
  const parsed = auth.parseToken(token);
  if (!parsed) { ws.close(4001, 'Unauthorized'); return; }
  const user = auth.getUser(parsed.userId);
  if (!user) { ws.close(4001, 'Unauthorized'); return; }

  setOnline(user.id, ws);
  send(ws, { type: 'hello', user, serverTime: Date.now() });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    const t = msg.type;

    if (t === 'ping') {
      send(ws, { type: 'pong', t: Date.now() });
      return;
    }

    if (t === 'typing') {
      const peerId = msg.to;
      if (!peerId) return;
      ensureChat(user.id, peerId);
      broadcastToUser(peerId, { type: 'typing', from: user.id, chatId: chatIdFor(user.id, peerId) });
      return;
    }

    if (t === 'chat') {
      // ciphertext only — server stores and relays, cannot decrypt
      const to = msg.to;
      if (!to || !msg.ciphertext || !msg.iv || !msg.typeMsg) return;
      const peer = auth.getUser(to);
      if (!peer) { send(ws, { type: 'error', error: 'Peer not found' }); return; }
      const chat = ensureChat(user.id, to);
      const stored = storeMessage({
        id: 'm_' + crypto.randomBytes(8).toString('hex'),
        chatId: chat.id,
        from: user.id,
        to,
        type: msg.typeMsg, // text | image | file | voice
        ciphertext: msg.ciphertext,
        iv: msg.iv,
        meta: msg.meta || null, // encrypted-filename hint sizes etc (non-sensitive ok)
        mediaId: msg.mediaId || null,
        createdAt: Date.now(),
        deliveredAt: null,
        readAt: null
      });
      send(ws, { type: 'chat_ack', message: stored });
      broadcastToUser(to, { type: 'chat', message: stored });
      // delivered if peer online
      if (online.has(to)) {
        stored.deliveredAt = Date.now();
        // update stored
        const all = db.messages();
        const arr = all[chat.id] || [];
        const ix = arr.findIndex(m => m.id === stored.id);
        if (ix >= 0) { arr[ix] = stored; all[chat.id] = arr; db.saveMessages(all); }
        broadcastToUser(user.id, { type: 'receipt', messageId: stored.id, chatId: chat.id, status: 'delivered', at: stored.deliveredAt });
      }
      return;
    }

    if (t === 'receipt') {
      const { messageId, chatId, status } = msg;
      if (!messageId || !chatId || !status) return;
      const chat = db.chats()[chatId];
      if (!chat || !chat.members.includes(user.id)) return;
      const all = db.messages();
      const arr = all[chatId] || [];
      const m = arr.find(x => x.id === messageId);
      if (!m) return;
      if (status === 'delivered' && !m.deliveredAt) m.deliveredAt = Date.now();
      if (status === 'read') m.readAt = Date.now();
      db.saveMessages(all);
      const other = chat.members.find(id => id !== user.id);
      broadcastToUser(other, { type: 'receipt', messageId, chatId, status, at: status === 'read' ? m.readAt : m.deliveredAt });
      return;
    }

    // WebRTC signaling — authenticated; SDP/ICE relayed only to intended peer.
    // Media itself is DTLS-SRTP end-to-end; server never sees call audio/video plaintext.
    if (t === 'call_invite' || t === 'call_accept' || t === 'call_reject' ||
        t === 'call_hangup' || t === 'webrtc_offer' || t === 'webrtc_answer' ||
        t === 'webrtc_ice') {
      const to = msg.to;
      if (!to) return;
      const payload = { ...msg, from: user.id };
      if (!online.has(to)) {
        if (t === 'call_invite') send(ws, { type: 'call_unavailable', to });
        return;
      }
      broadcastToUser(to, payload);
      return;
    }
  });

  ws.on('close', () => setOffline(ws));
  ws.on('error', () => setOffline(ws));
});

server.listen(PORT, HOST, () => {
  console.log(`Linko server listening on http://${HOST}:${PORT}`);
  console.log(`Web UI: http://127.0.0.1:${PORT}/`);
  console.log(`WS:     ws://127.0.0.1:${PORT}/ws`);
});
