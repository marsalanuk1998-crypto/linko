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
| Push / SMS OTP | Not used (no paid SMS). Phone number is an identifier + PIN only — not carrier-verified. |
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

## Auth

- Identifier: phone number (normalized digits).
- Secret: user PIN (4–32 chars), hashed as above.
- Session: opaque token + HMAC (`server/.secret`) + expiry embedded; validated on REST and WS.

## Android packaging

- Package: `pk.zaib.linko`
- `allowBackup=false`
- Permissions: INTERNET, CAMERA, RECORD_AUDIO (for calls / voice notes)
- Web UI loaded from `https://appassets.androidplatform.net/` (secure origin) so WebCrypto / WebRTC work.
