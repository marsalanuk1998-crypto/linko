'use strict';
/**
 * Auth/OTP test. Starts its own server copy in a temp dir with LINKO_MAIL_DEV=1 / LINKO_WA_DEV=1
 * and reads codes from the server log. Run: node tests/auth-otp.js
 */
const { spawn, execSync } = require('child_process');
const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http');

const ROOT = path.join(__dirname, '..');
let results = []; let log = '';
const ok = (name, cond, extra) => { results.push({ name, pass: !!cond, extra }); console.log((cond ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };

function startServer(env, port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'linko-test-'));
  execSync(`cp -r ${ROOT}/server ${dir}/server && rm -rf ${dir}/server/data ${dir}/server/.secret`);
  const p = spawn('node', ['server/src/index.js'], { cwd: dir, env: { ...process.env, PORT: String(port), LINKO_WEB_ROOT: ROOT + '/web', ...env } });
  p.stdout.on('data', d => log += d); p.stderr.on('data', d => log += d);
  return new Promise(r => setTimeout(() => r(p), 600));
}
function req(port, method, p, body, token) {
  const data = body ? Buffer.from(JSON.stringify(body)) : null;
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(data ? { 'Content-Length': data.length } : {}) } }, res => {
      const c = []; res.on('data', x => c.push(x)); res.on('end', () => { let j = {}; try { j = JSON.parse(Buffer.concat(c)); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const lastCode = (tag, who) => { const re = new RegExp(`\\[${tag}\\] OTP for ${who.replace(/[+.]/g, '\\$&')}[^:]*: (\\d{6})`, 'g'); let m, c = null; while ((m = re.exec(log))) c = m[1]; return c; };
const PK = 'dGVzdC1wdWJsaWMta2V5'; const DEV1 = 'a'.repeat(32); const DEV2 = 'b'.repeat(32);

(async () => {
  // ---------- Server A: both channels ----------
  let s = await startServer({ LINKO_MAIL_DEV: '1', LINKO_WA_DEV: '1', LINKO_OTP_RESEND_SECONDS: '0' }, 18801); const P = 18801;
  let r = await req(P, 'GET', '/api/auth-info');
  ok('auth-info lists whatsapp+email', JSON.stringify(r.body.channels) === '["whatsapp","email"]', JSON.stringify(r.body));
  // bootstrap user via WhatsApp
  r = await req(P, 'POST', '/api/register', { phone: '+923001111111', displayName: 'Admin', pin: '123456', publicKey: PK, channel: 'whatsapp', deviceId: DEV1 });
  ok('register → 202 otpRequired (whatsapp)', r.status === 202 && r.body.otpRequired && r.body.channel === 'whatsapp', r.body.sentTo);
  const t1 = r.body.ticket;
  r = await req(P, 'POST', '/api/register/verify', { ticket: t1, otp: '000000' });
  ok('wrong OTP rejected', r.status === 400, r.body.error);
  r = await req(P, 'POST', '/api/register/verify', { ticket: t1, otp: lastCode('wa-dev', '+923001111111') });
  ok('correct WhatsApp OTP creates account', r.status === 201 && r.body.user.phoneVerified, r.body.user && r.body.user.phone);
  const adminTok = r.body.token;
  r = await req(P, 'POST', '/api/register/verify', { ticket: t1, otp: lastCode('wa-dev', '+923001111111') });
  ok('OTP ticket single-use', r.status === 400);
  // second user via WhatsApp needs no invite
  r = await req(P, 'POST', '/api/register', { phone: '+923002222222', displayName: 'Bob', pin: '654321', publicKey: PK, channel: 'whatsapp' });
  ok('WhatsApp signup needs no invite', r.status === 202, r.body.error);
  r = await req(P, 'POST', '/api/register/verify', { ticket: r.body.ticket, otp: lastCode('wa-dev', '+923002222222') });
  ok('Bob created', r.status === 201);
  // email signup without invite → rejected
  r = await req(P, 'POST', '/api/register', { phone: '+923003333333', email: 'c@example.com', displayName: 'C', pin: '111111', publicKey: PK, channel: 'email' });
  ok('email signup without invite rejected (email does not prove phone)', r.status === 400 && /Invite/.test(r.body.error), r.body.error);
  // invite locked to phone
  r = await req(P, 'POST', '/api/invites', { phone: '+923003333333' }, adminTok);
  ok('invite created', r.status === 201, r.body.invite && r.body.invite.code);
  const inv = r.body.invite.code;
  r = await req(P, 'POST', '/api/register', { phone: '+923009999999', email: 'x@example.com', displayName: 'X', pin: '111111', publicKey: PK, channel: 'email', inviteCode: inv });
  ok('phone-locked invite rejects other number', r.status === 400, r.body.error);
  r = await req(P, 'POST', '/api/register', { phone: '+923003333333', email: 'c@example.com', displayName: 'C', pin: '111111', publicKey: PK, channel: 'email', inviteCode: inv, deviceId: DEV1 });
  ok('email signup with invite → OTP to email', r.status === 202 && r.body.channel === 'email', r.body.sentTo);
  r = await req(P, 'POST', '/api/register/verify', { ticket: r.body.ticket, otp: lastCode('mail-dev', 'c@example.com') });
  ok('email OTP creates account', r.status === 201 && r.body.user.emailVerified);
  // squatting: register an existing number
  r = await req(P, 'POST', '/api/register', { phone: '+923002222222', displayName: 'Evil', pin: '999999', publicKey: PK, channel: 'whatsapp' });
  ok('already-registered phone rejected', r.status === 400, r.body.error);
  // login known device = no OTP
  r = await req(P, 'POST', '/api/login', { phone: '+923001111111', pin: '123456', deviceId: DEV1 });
  ok('login known device → token, no OTP', r.status === 200 && r.body.token);
  // login new device → OTP
  r = await req(P, 'POST', '/api/login', { phone: '+923001111111', pin: '123456', deviceId: DEV2 });
  ok('login new device → OTP required', r.status === 202 && r.body.otpRequired, r.body.sentTo);
  r = await req(P, 'POST', '/api/login/verify', { ticket: r.body.ticket, otp: lastCode('wa-dev', '+923001111111') });
  ok('new device verified', r.status === 200 && r.body.token);
  // email-only user on new device asked for email: has no WA verification but WA channel available → pick email explicitly
  r = await req(P, 'POST', '/api/login', { phone: '+923003333333', pin: '111111', deviceId: DEV2, channel: 'email' });
  ok('login new device via email', r.status === 202 && r.body.channel === 'email');
  // wrong PIN lockout
  let last;
  for (let i = 0; i < 6; i++) last = await req(P, 'POST', '/api/login', { phone: '+923002222222', pin: '000000', deviceId: DEV1 });
  ok('PIN brute-force lockout after 5 fails', /Too many attempts/.test(last.body.error), last.body.error);
  // reset PIN
  r = await req(P, 'POST', '/api/pin-reset', { phone: '+923001111111', channel: 'whatsapp' });
  await new Promise(x => setTimeout(x, 50));
  const rc = lastCode('wa-dev', '+923001111111');
  r = await req(P, 'POST', '/api/pin-reset/verify', { ticket: r.body.ticket, otp: rc, newPin: '24681357', deviceId: DEV1 });
  ok('PIN reset via WhatsApp OTP', r.status === 200 && r.body.token, r.body.error);
  r = await req(P, 'POST', '/api/login', { phone: '+923001111111', pin: '24681357', deviceId: DEV1 });
  ok('login with new PIN', r.status === 200);
  r = await req(P, 'POST', '/api/pin-reset', { phone: '+920000000000' });
  ok('reset for unknown phone gives same-shaped answer', r.status === 202 && r.body.ticket);
  s.kill();
  s = await startServer({ LINKO_WA_DEV: '1' }, 18804);
  r = await req(18804, 'POST', '/api/register', { phone: '+923004444444', displayName: 'D', pin: '111111', publicKey: PK, channel: 'whatsapp' });
  r = await req(18804, 'POST', '/api/register', { phone: '+923004444444', displayName: 'D', pin: '111111', publicKey: PK, channel: 'whatsapp' });
  ok('OTP resend rate-limited (60s default)', r.status === 400 && /wait/.test(r.body.error), r.body.error);
  s.kill();

  // ---------- Server B: no OTP channel → invite-only ----------
  s = await startServer({}, 18802); const Q = 18802;
  r = await req(Q, 'GET', '/api/auth-info');
  ok('no SMTP/WA → channels empty', r.body.channels.length === 0);
  r = await req(Q, 'POST', '/api/register', { phone: '+923001111111', displayName: 'A', pin: '123456', publicKey: PK });
  ok('bootstrap first account free', r.status === 201);
  const at = r.body.token;
  r = await req(Q, 'POST', '/api/register', { phone: '+923002222222', displayName: 'B', pin: '123456', publicKey: PK });
  ok('2nd account without invite rejected', r.status === 400 && /Invite/.test(r.body.error));
  r = await req(Q, 'POST', '/api/invites', {}, at);
  r = await req(Q, 'POST', '/api/register', { phone: '+923002222222', displayName: 'B', pin: '123456', publicKey: PK, inviteCode: r.body.invite.code.toLowerCase() });
  ok('2nd account with invite ok', r.status === 201);
  s.kill();

  // ---------- Server C: bootstrap invite env ----------
  s = await startServer({ LINKO_BOOTSTRAP_INVITE: 'SETUP-12345' }, 18803);
  r = await req(18803, 'POST', '/api/register', { phone: '+923001111111', displayName: 'A', pin: '123456', publicKey: PK });
  ok('LINKO_BOOTSTRAP_INVITE enforced for first account', r.status === 400);
  r = await req(18803, 'POST', '/api/register', { phone: '+923001111111', displayName: 'A', pin: '123456', publicKey: PK, inviteCode: 'setup12345' });
  ok('first account with bootstrap invite ok', r.status === 201);
  s.kill();

  const fails = results.filter(x => !x.pass).length;
  fs.writeFileSync(path.join(__dirname, 'results_auth_otp.json'), JSON.stringify({ at: new Date().toISOString(), passed: results.length - fails, failed: fails, results }, null, 2));
  console.log(`\n${results.length - fails}/${results.length} passed`);
  process.exit(fails ? 1 : 0);
})().catch(e => { console.error(e); console.log(log); process.exit(1); });
