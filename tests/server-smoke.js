'use strict';
/**
 * Automated smoke: register two users, E2EE round-trip via API+WS, presence.
 * Server must already be running on LINKO_URL (default http://127.0.0.1:8787).
 */
const crypto = require('crypto');
const http = require('http');
const { WebSocket } = require('/workspace/linko-app/server/node_modules/ws');

const BASE = process.env.LINKO_URL || 'http://127.0.0.1:8787';

function req(method, path, body, token) {
  const u = new URL(path, BASE);
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method, headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: 'Bearer ' + token } : {}),
        ...(data ? { 'Content-Length': data.length } : {})
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let json = {};
        try { json = JSON.parse(raw || '{}'); } catch {}
        if (res.statusCode >= 400) reject(new Error(JSON.stringify(json)));
        else resolve(json);
      });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

function wsConnect(token) {
  const u = BASE.replace(/^http/, 'ws') + '/ws?token=' + encodeURIComponent(token);
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(u);
    const inbox = [];
    ws.on('message', d => inbox.push(JSON.parse(String(d))));
    ws.on('open', () => resolve({ ws, inbox, wait }));
    ws.on('error', reject);
    function wait(type, ms = 5000) {
      const start = Date.now();
      return new Promise((res, rej) => {
        (function poll() {
          const i = inbox.findIndex(m => m.type === type);
          if (i >= 0) return res(inbox.splice(i, 1)[0]);
          if (Date.now() - start > ms) return rej(new Error('timeout waiting for ' + type));
          setTimeout(poll, 50);
        })();
      });
    }
  });
}

// Minimal Node stand-in: we only test server relay of ciphertext (real E2EE is in browser WebCrypto).
async function main() {
  const results = [];
  function ok(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log((pass ? 'PASS' : 'FAIL') + '  ' + name + (detail ? ' — ' + detail : ''));
  }

  try {
    const health = await req('GET', '/api/health');
    ok('health', health.ok === true, health.name);
  } catch (e) {
    ok('health', false, e.message);
    console.log(JSON.stringify({ ok: false, results }, null, 2));
    process.exit(1);
  }

  const phoneA = '+999' + crypto.randomBytes(4).readUInt32BE(0).toString().slice(0, 8);
  const phoneB = '+998' + crypto.randomBytes(4).readUInt32BE(0).toString().slice(0, 8);
  const pubA = 'PUBA_' + crypto.randomBytes(8).toString('hex');
  const pubB = 'PUBB_' + crypto.randomBytes(8).toString('hex');

  let A, B;
  try {
    A = await req('POST', '/api/register', { phone: phoneA, displayName: 'Alice Test', pin: '1234', publicKey: pubA });
    let inviteCode = '';
    try { inviteCode = (await req('POST', '/api/invites', {}, A.token)).invite.code; } catch {}
    B = await req('POST', '/api/register', { phone: phoneB, displayName: 'Bob Test', pin: '5678', publicKey: pubB, inviteCode });
    ok('register', !!(A.token && B.token && A.user.linkoId), A.user.linkoId + ' / ' + B.user.linkoId);
  } catch (e) {
    ok('register', false, e.message);
    process.exit(1);
  }

  try {
    const login = await req('POST', '/api/login', { phone: phoneA, pin: '1234' });
    ok('login', !!login.token, 'token ok');
    try {
      await req('POST', '/api/login', { phone: phoneA, pin: '9999' });
      ok('bad-pin-rejected', false, 'should have failed');
    } catch {
      ok('bad-pin-rejected', true);
    }
  } catch (e) {
    ok('login', false, e.message);
  }

  try {
    const search = await req('GET', '/api/search?q=' + encodeURIComponent(phoneB), null, A.token);
    ok('search', (search.users || []).some(u => u.id === B.user.id), 'found bob');
  } catch (e) {
    ok('search', false, e.message);
  }

  // WS ciphertext relay
  try {
    const a = await wsConnect(A.token);
    const b = await wsConnect(B.token);
    await a.wait('hello');
    await b.wait('hello');
    const fakeCt = crypto.randomBytes(32).toString('base64');
    const fakeIv = crypto.randomBytes(12).toString('base64');
    a.ws.send(JSON.stringify({
      type: 'chat', to: B.user.id, typeMsg: 'text',
      ciphertext: fakeCt, iv: fakeIv
    }));
    const ack = await a.wait('chat_ack');
    const got = await b.wait('chat');
    ok('ws-chat-relay',
      got.message.ciphertext === fakeCt && got.message.iv === fakeIv && ack.message.id === got.message.id,
      'ciphertext unchanged');
    // Server must not transform ciphertext
    ok('server-blind-ciphertext', got.message.ciphertext === fakeCt);

    // Call signaling
    a.ws.send(JSON.stringify({ type: 'call_invite', to: B.user.id, callType: 'voice' }));
    const invite = await b.wait('call_invite');
    ok('call-signaling', invite.from === A.user.id && invite.callType === 'voice');

    a.ws.close(); b.ws.close();
  } catch (e) {
    ok('ws-chat-relay', false, e.message);
  }

  // PIN hash not in public user
  ok('no-pin-in-public-user', !('pinHash' in A.user) && !('pinSalt' in A.user));

  const failed = results.filter(r => !r.pass);
  console.log('\n' + results.length + ' checks, ' + failed.length + ' failed');
  require('fs').writeFileSync('/workspace/linko-app/tests/results_smoke.json', JSON.stringify({ ok: failed.length === 0, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
