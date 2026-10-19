'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const BASE = 'http://127.0.0.1:8787';
const OUT = '/workspace/linko-app/screens';
fs.mkdirSync(OUT, { recursive: true });

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function chromeShot(url, file, extraArgs = []) {
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--window-size=390,844',
    '--hide-scrollbars', `--screenshot=${file}`, ...extraArgs, url
  ];
  await new Promise((resolve, reject) => {
    const p = spawn('/usr/bin/google-chrome', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    p.stderr.on('data', d => err += d);
    p.on('close', code => code === 0 || fs.existsSync(file) ? resolve() : reject(new Error(err || 'chrome fail')));
  });
}

(async () => {
  // Auth screen
  await chromeShot(BASE + '/', path.join(OUT, '01_auth.png'));
  console.log('shot auth');

  // Register via API then inject session through a helper page is hard in pure chrome CLI.
  // Instead open with a data URL bootstrap... better: use a tiny HTML harness served by server.
  const harness = `<!DOCTYPE html><html><body>
<script>
(async () => {
  const te = new TextEncoder();
  function b64(buf){return btoa(String.fromCharCode(...new Uint8Array(buf)));}
  const pair = await crypto.subtle.generateKey({name:'ECDH',namedCurve:'P-256'},true,['deriveBits']);
  const pub = b64(await crypto.subtle.exportKey('spki', pair.publicKey));
  const priv = b64(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const phone = '+92111' + Math.floor(Math.random()*1e7);
  const res = await fetch('/api/register',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({phone,displayName:'Arsalan Demo',pin:'123456',publicKey:pub})});
  const out = await res.json();
  localStorage.setItem('linko.server', location.origin);
  localStorage.setItem('linko.token', out.token);
  localStorage.setItem('linko.user', JSON.stringify(out.user));
  localStorage.setItem('linko.priv', priv);
  localStorage.setItem('linko.pub', pub);
  location.href = '/index.html';
})();
</script>boot</body></html>`;
  fs.writeFileSync('/workspace/linko-app/web/shot-boot.html', harness);

  // Use same user-data-dir so localStorage persists across shots? Chrome headless screenshot is one-shot.
  // Use remote debugging + puppeteer-like via chrome DevTools is heavy.
  // Simpler: dump auth + static call overlay via CSS class injection page.

  await chromeShot(BASE + '/shot-boot.html', path.join(OUT, '02_chats.png'));
  // shot-boot redirects; chrome --screenshot may capture before redirect. Use longer delay via virtual time?
  // Chrome headless screenshot doesn't wait for SPA. Use --virtual-time-budget
  await chromeShot(BASE + '/shot-boot.html', path.join(OUT, '02_chats.png'), ['--virtual-time-budget=8000']);
  console.log('shot chats');

  // Call overlay static preview page
  const callPrev = fs.readFileSync('/workspace/linko-app/web/index.html','utf8')
    .replace('id="screen-boot" class="screen center"', 'id="screen-boot" class="screen center hidden"')
    .replace('id="screen-call" class="screen call-overlay hidden"', 'id="screen-call" class="screen call-overlay"');
  // Actually easier separate preview
  fs.writeFileSync('/workspace/linko-app/web/shot-call.html', `<!DOCTYPE html>
<html><head><link rel="stylesheet" href="css/app.css"/></head>
<body><div id="app"><section class="screen call-overlay">
<div class="call-panel">
<div class="call-peer">Arsalan</div>
<div class="call-state">Encrypted · connected</div>
<div class="video-wrap" style="background:#102038"></div>
<div class="call-actions">
<button class="fab reject">✕</button>
<button class="fab ghost">🔇</button>
</div>
<p class="hint call-secure">🔒 Encrypted call (DTLS-SRTP)</p>
</div></section></div></body></html>`);
  await chromeShot(BASE + '/shot-call.html', path.join(OUT, '03_encrypted_call.png'));
  console.log('shot call');

  // Auth again clearer
  await chromeShot(BASE + '/index.html', path.join(OUT, '01_auth.png'), ['--virtual-time-budget=3000']);

  console.log('done', fs.readdirSync(OUT));
})().catch(e => { console.error(e); process.exit(1); });
