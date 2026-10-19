'use strict';
/**
 * WhatsApp OTP via Meta WhatsApp Cloud API (official; no unofficial/scraped gateways).
 * The code is sent to the SAME phone number the user is registering / logging in with,
 * so receiving it proves that person controls that number's WhatsApp.
 *
 * Env (all required to enable):
 *   WA_TOKEN            permanent System User access token (Meta Business → System users)
 *   WA_PHONE_NUMBER_ID  "Phone number ID" from WhatsApp → API Setup
 *   WA_TEMPLATE_NAME    approved AUTHENTICATION template name (e.g. linko_otp)
 * Optional:
 *   WA_TEMPLATE_LANG    default "en_US"
 *   WA_TEMPLATE_BUTTON  "1" (default) if the template has the standard Copy-code button, "0" otherwise
 *   WA_API_VERSION      default "v21.0"
 *   LINKO_WA_DEV=1      log codes instead of sending (local testing only)
 */
const https = require('https');

const DEV = process.env.LINKO_WA_DEV === '1';
let lastError = null;
const devOutbox = [];

function configured() {
  return DEV || !!(process.env.WA_TOKEN && process.env.WA_PHONE_NUMBER_ID && process.env.WA_TEMPLATE_NAME);
}

function post(path, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'graph.facebook.com', path, method: 'POST', timeout: 15000,
      headers: {
        Authorization: 'Bearer ' + process.env.WA_TOKEN,
        'Content-Type': 'application/json', 'Content-Length': body.length
      }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        let j = {};
        try { j = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        if (res.statusCode < 300) resolve(j);
        else reject(new Error((j.error && j.error.message) || ('HTTP ' + res.statusCode)));
      });
    });
    r.on('timeout', () => r.destroy(new Error('WhatsApp API timeout')));
    r.on('error', reject);
    r.write(body); r.end();
  });
}

async function sendOtp(phone, code) {
  const to = String(phone).replace(/\D/g, '');
  if (DEV) { devOutbox.push({ to, code, at: Date.now() }); console.log(`[wa-dev] OTP for +${to}: ${code}`); return; }
  const components = [{ type: 'body', parameters: [{ type: 'text', text: code }] }];
  if (process.env.WA_TEMPLATE_BUTTON !== '0') {
    components.push({ type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] });
  }
  try {
    await post(`/${process.env.WA_API_VERSION || 'v21.0'}/${process.env.WA_PHONE_NUMBER_ID}/messages`, {
      messaging_product: 'whatsapp', to, type: 'template',
      template: { name: process.env.WA_TEMPLATE_NAME, language: { code: process.env.WA_TEMPLATE_LANG || 'en_US' }, components }
    });
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error('[whatsapp] send failed:', e.message);
    throw new Error('Could not send WhatsApp code — is WhatsApp installed on this number? Try email instead.');
  }
}

function status() { return { configured: configured(), dev: DEV, lastError }; }
module.exports = { configured, sendOtp, status, devOutbox };
