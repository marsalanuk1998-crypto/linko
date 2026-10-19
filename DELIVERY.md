# Linko v1.0.0 delivery

## APK
- Path: `/workspace/Linko.apk`
- Size: ~68 KB
- package: `pk.zaib.linko`
- versionName: `1.0.0` / versionCode: `1`
- Keystore: `/workspace/linko-app/android/linko-release.jks`
- Cert SHA-256: `73:68:6F:CB:7D:BD:4B:4F:CA:8C:BB:01:6F:8A:8F:7C:65:B1:9E:98:87:BD:6F:26:1C:E0:0A:97:6A:35:5C:42`
- Passwords: see `android/KEYSTORE_NOTES.txt`

## Auth + E2EE (plain words)
- Sign up with phone number + PIN. PIN is hashed (PBKDF2) on the server; never stored plain.
- Each phone generates an ECDH key pair. Private key stays on the phone. Public key goes to the server so others can encrypt to you.
- Chat text/files/voice are AES-GCM encrypted on the phone before they touch the network. Server only stores/relays ciphertext.
- Voice/video calls use WebRTC **DTLS-SRTP** (encrypted media). Server only forwards call signaling (who is calling + SDP/ICE), never call audio/video.

## Multi-device connect
```bash
cd /workspace/linko-app/server && npm start   # port 8787
```
On each phone: Server settings → `http://<LAN-IP>:8787` → register different phones → search → chat/call.

Demo server currently runnable on this box at `http://127.0.0.1:8787` (no public IP without user’s cloud/tunnel).

## Tests
- `tests/server-smoke.js`: 9/9 PASS (auth, search, blind ciphertext relay, call signaling)
- `tests/e2ee-unit.js`: PASS round-trip + wrong-peer rejected
- Screens: `screens/01_auth.png` … `04_chat.png`
- Manual checklist: `tests/MANUAL_CHECKLIST.md`

## Blockers needing user cloud account
- None to install/run on LAN.
- Optional later: public HTTPS host, TURN server for hard NATs, paid SMS OTP — not required for v1.
