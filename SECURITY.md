# Linko Security Notes

## Threat model (honest)

### Protected
| Asset | Protection |
|-------|------------|
| Account PIN | PBKDF2-SHA256 (120k iterations) + random salt. Never stored in plaintext. |
| Chat message bodies | End-to-end encryption (E2EE). Server stores ciphertext + IV only. |
| Images / files / voice notes | Encrypted client-side with AES-256-GCM before upload. Server stores opaque blobs. |
| Voice & video call media | **DTLS-SRTP** (mandatory in WebRTC). Media is peer-to-peer encrypted. Linko server relays only signaling (SDP/ICE), never audio/video plaintext. A network MITM cannot read call media when DTLS is connected. |
| Signaling authenticity | WebSocket requires a Bearer session token (HMAC-bound, 30-day). Call invites/offers only accepted from authenticated sessions. |
| Release APK | Signed with dedicated `linko-release.jks` (RSA 4096). Not debuggable. |

### Not guaranteed on free self-host
| Risk | Reality |
|------|---------|
| Metadata | Server *can* see who talks to whom, when, message sizes, and that a call happened. Free hosting does not hide metadata. |
| SMS OTP | Not used (SMS is paid per message). Phone ownership is proven instead by a **WhatsApp OTP sent to that same number** (if WhatsApp Cloud API is configured). See *Auth & phone ownership* below. |
| TURN / some NATs | Free STUN only. Strict NATs may block calls without a TURN server (user would need to host one). |
| Device compromise | If the phone is unlocked/malware, localStorage private keys and decrypted UI can be read. |
| Server admin | Cannot read message bodies or call media, but can ban users, drop messages, or lie about presence. |
| Cleartext LAN | Default demo may use `ws://` / `http://` on a LAN. Prefer HTTPS/WSS behind a reverse proxy for internet exposure. |

## Crypto scheme (E2EE chat)

1. **Identity key**: ECDH P-256 key pair generated in-browser (WebCrypto) at registration.
2. **Public key** uploaded to server (for peer discovery). **Private key** stays on device (`localStorage`).
3. **Per-peer AES key**: `ECDH(myPrivate, peerPublic)` → bits → **HKDF-SHA-256** (salt `linko-v1-salt`, info `linko-chat-aes-256-gcm`) → AES-256-GCM key.
4. **Each message**: random 96-bit IV + AES-GCM ciphertext. Text ciphertext is relayed in the WS payload; media ciphertext is uploaded as a binary blob (`/api/media`) with IV on the message envelope.
5. Server **cannot** decrypt: it has no private keys and no AES keys.

This is a simplified pairwise scheme (not full Signal Double Ratchet). It provides confidentiality against the server and passive network attackers. It does **not** yet provide forward secrecy after key compromise or post-compromise recovery.

## Encrypted calls (required)

- Browser `RTCPeerConnection` always negotiates **DTLS** for key exchange and **SRTP** for media.
- Linko never implements a plaintext RTP path.
- Signaling (`call_invite`, `webrtc_offer`, `webrtc_answer`, `webrtc_ice`) is sent only over an **authenticated** WebSocket and only to the addressed peer id.
- UI shows “Encrypted call (DTLS-SRTP)” on the call screen.

## Auth & phone ownership (v1.2.0)

**Problem fixed:** in v1.0/v1.1 anyone could register a friend's phone number, because the number was never verified (no SMS OTP).

**Identity:** phone number (Linko ID). **Secret:** PIN (4–32 chars, 6+ recommended), PBKDF2-SHA256 120k + salt.
**Session:** opaque token + HMAC (`server/.secret`) + expiry, validated on REST and WS.

### Free OTP channels (no SMS)
| Channel | What it proves | Config |
|---|---|---|
| **WhatsApp OTP** (code sent to the *same* phone number via official WhatsApp Cloud API template) | The person controls WhatsApp on that number → **proves phone ownership** | `WA_TOKEN`, `WA_PHONE_NUMBER_ID`, `WA_TEMPLATE_NAME` |
| **Email OTP** (SMTP or Brevo HTTPS API) | The person controls that **email** only — **does NOT prove the phone number** | `SMTP_*` or `BREVO_API_KEY` + `MAIL_FROM` |
| **Invite code** (one-time, 7 days, optionally locked to the friend's phone) | An existing user vouches for the newcomer | always available |

### Registration policy (server-enforced)
1. First account on an empty server: free, unless `LINKO_BOOTSTRAP_INVITE` is set (then that code is required). **Set it on a public server** so a stranger can't become the first user.
2. WhatsApp OTP verified → account created, `phoneVerified=true`, no invite needed.
3. Email OTP verified → account created, `emailVerified=true`, **invite still required** (because email doesn't prove the phone). Override with `LINKO_EMAIL_SIGNUP_NO_INVITE=1` (not recommended).
4. No OTP channel configured → **invite-only**.
5. `LINKO_REQUIRE_INVITE=1` → invite required for everyone.
6. A number that is already registered can never be registered again.

### Login
- Phone + PIN. On a **new device** (unknown `deviceId`) the server also requires an OTP to the account's verified channel (WhatsApp of the number, or verified email). Known devices log in with PIN only.
- Accounts created before v1.2.0 have no verified channel and keep PIN-only login until re-registered.
- **Forgot PIN:** OTP to WhatsApp/verified email → set new PIN; all other trusted devices are dropped. Unknown numbers get a same-shaped response (no account enumeration).

### Abuse limits
- OTP: 6 digits, stored only as HMAC, 10-min expiry, 5 wrong tries then dead, single-use; max 1 send/min and 5/hour per destination.
- PIN: 5 wrong tries per phone → 15-min lock; 20 per IP → 15-min lock (in-memory, resets on restart).
- Invites: ~50-bit random codes, single-use, 7-day expiry, max 20 unused per user.

### Remaining risks (honest)
- **Email-only accounts** rely on the invite for phone trust: the inviter is vouching. Lock invites to the friend's number.
- A WhatsApp OTP proves the number *today*; if a SIM/number is recycled the new holder could reset the PIN.
- If WhatsApp Cloud API is not configured, phone numbers are **not verified**; only invites protect against squatting.
- 4-digit PINs are weak; lockouts slow guessing but a 6+ digit PIN is strongly recommended.
- Temp-SMS / unofficial WhatsApp gateways are deliberately **not** used (they expose codes to third parties).

## Android packaging

- Package: `pk.zaib.linko`
- `allowBackup=false`
- Permissions: INTERNET, CAMERA, RECORD_AUDIO (for calls / voice notes)
- Web UI loaded from `https://appassets.androidplatform.net/` (secure origin) so WebCrypto / WebRTC work.
