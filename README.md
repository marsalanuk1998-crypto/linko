# Linko

Secure WhatsApp-like messenger for **Muhammad Arsalan / Zaib International**.  
English UI. Package `pk.zaib.linko`. **Not** connected to WhatsApp.

## What’s included

- Phone + PIN accounts (no paid SMS OTP)
- 1:1 encrypted chat: text, images, documents, voice notes
- Voice & video calls over **encrypted WebRTC (DTLS-SRTP)**
- Read receipts, typing indicator, online / last-seen
- User search by phone, Linko ID, or name
- Configurable server URL (two phones → same server)
- Signed release APK: `/workspace/Linko.apk`

## Quick start (two devices on one Wi‑Fi)

### 1. Run the server (laptop / PC / this box)

```bash
cd /workspace/linko-app/server
npm start
# listens on http://0.0.0.0:8787
```

Find the machine’s LAN IP (e.g. `192.168.1.10`).

### 2. Install the APK

Install `/workspace/Linko.apk` on both phones (enable “install unknown apps” if needed).

### 3. Point both apps at the server

On the login screen → **Server settings** → enter:

```text
http://192.168.1.10:8787
```

(Save). Create an account on each phone with different phone numbers + PINs. Search by phone or Linko ID and chat / call.

### Web browser testing

Open `http://127.0.0.1:8787/` in two browser profiles (or normal + private). Same flow.

## Rebuild APK

```bash
cd /workspace/linko-app/android
VERSION_CODE=2 VERSION_NAME=1.0.1 ./build.sh
# output: /workspace/Linko.apk
```

Keystore notes: `android/KEYSTORE_NOTES.txt` (keep a backup off-box).

## Tests

```bash
cd /workspace/linko-app/server && npm start &
node /workspace/linko-app/tests/server-smoke.js
```

Manual checklist + screenshots: `screens/` and `tests/MANUAL_CHECKLIST.md`.

## Security

See **[SECURITY.md](./SECURITY.md)** — E2EE chat, DTLS-SRTP calls, PIN hashing, threat model.

## Stack

- Client: HTML/CSS/JS in Android WebView (same proven pattern as ZAIB Docs / Kharcha)
- Server: Node.js + `ws`, JSON file DB (free, no cloud account required)
- Crypto: WebCrypto ECDH P-256 + AES-256-GCM; WebRTC DTLS-SRTP

## Limits (honest)

- Free STUN only — some mobile networks need TURN for calls
- No group chats / status stories in v1
- Phone numbers are not SMS-verified
- Server sees metadata (who/when), not message or call media plaintext
- For public internet, put the server behind HTTPS (Caddy/nginx) and use `wss://`


## v1.2.0 auth
Phone + PIN login. Free OTP via WhatsApp (proves number) or Email, invite codes otherwise. No SMS. Setup: `OTP_SETUP.md`, threat model: `SECURITY.md`.
