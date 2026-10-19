'use strict';
/**
 * Email OTP delivery via SMTP (free: Gmail app password, Brevo free tier, etc.).
 * Env:
 *   SMTP_HOST, SMTP_PORT (587), SMTP_SECURE ("true" for 465), SMTP_USER, SMTP_PASS,
 *   SMTP_FROM (e.g. "Linko <yourname@gmail.com>")
 * OR (HTTPS, works even where the host blocks SMTP ports):
 *   BREVO_API_KEY, MAIL_FROM (verified sender email in Brevo), MAIL_FROM_NAME (default "Linko")
 *   Brevo free plan = 300 emails/day, no card.
 * If neither is configured, email OTP is disabled and the server falls
 * back to invite-only registration.
 * LINKO_MAIL_DEV=1 logs codes to stdout instead of sending (local testing only).
 */
const https = require('https');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch { /* optional */ }

const DEV = process.env.LINKO_MAIL_DEV === '1';
let transporter = null;
let lastError = null;
const devOutbox = []; // for tests when LINKO_MAIL_DEV=1

function brevo() { return !!(process.env.BREVO_API_KEY && process.env.MAIL_FROM); }
function smtp() { return !!(nodemailer && process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS); }
function configured() { return DEV || brevo() || smtp(); }

function brevoSend(to, subject, text) {
  const body = Buffer.from(JSON.stringify({
    sender: { email: process.env.MAIL_FROM, name: process.env.MAIL_FROM_NAME || 'Linko' },
    to: [{ email: to }], subject, textContent: text
  }));
  return new Promise((resolve, reject) => {
    const r = https.request({
      hostname: 'api.brevo.com', path: '/v3/smtp/email', method: 'POST', timeout: 15000,
      headers: { 'api-key': process.env.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json', 'Content-Length': body.length }
    }, res => {
      const c = []; res.on('data', x => c.push(x));
      res.on('end', () => res.statusCode < 300 ? resolve() : reject(new Error('Brevo HTTP ' + res.statusCode + ' ' + Buffer.concat(c).toString().slice(0, 200))));
    });
    r.on('timeout', () => r.destroy(new Error('Brevo timeout')));
    r.on('error', reject); r.write(body); r.end();
  });
}

function getTransport() {
  if (transporter) return transporter;
  const port = Number(process.env.SMTP_PORT || 587);
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE ? process.env.SMTP_SECURE === 'true' : port === 465,
    requireTLS: port === 587,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { minVersion: 'TLSv1.2' }
  });
  return transporter;
}

async function sendOtp(to, code, purpose) {
  const what = { register: 'create your Linko account', login: 'log in on a new device', reset: 'reset your Linko PIN' }[purpose] || 'continue';
  const text = `Your Linko code is ${code}\n\nUse it to ${what}. It expires in 10 minutes.\nIf you did not request this, ignore this email — nobody can use your account without this code.\nNever share this code with anyone.`;
  if (DEV) { devOutbox.push({ to, code, purpose, at: Date.now() }); console.log(`[mail-dev] OTP for ${to} (${purpose}): ${code}`); return; }
  const subject = `Linko code: ${code}`;
  try {
    if (brevo()) await brevoSend(to, subject, text);
    else await getTransport().sendMail({ from: process.env.SMTP_FROM || process.env.SMTP_USER, to, subject, text });
    lastError = null;
  } catch (e) {
    lastError = e.message;
    console.error('[mail] send failed:', e.message);
    throw new Error('Could not send email code — try again later');
  }
}

function status() { return { configured: configured(), provider: DEV ? 'dev' : brevo() ? 'brevo' : smtp() ? 'smtp' : null, lastError }; }

module.exports = { configured, sendOtp, status, devOutbox };
