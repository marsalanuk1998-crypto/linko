# Linko v1.2.0 delivery — phone ownership fix (free OTP, no SMS)

## APK
- Path: `/workspace/Linko.apk` — package `pk.zaib.linko`, versionName `1.2.0`, versionCode `3`
- Default server: `https://linko-018a.onbelmo.uk`
- Signed with the existing `android/linko-release.jks` (same cert as v1.0/v1.1 → installs as an update)

## What changed
- Login = **phone + PIN** (phone is your Linko ID).
- Sign-up sends a free **6-digit OTP via WhatsApp (to that same number) or Email**. No SMS (paid).
  - WhatsApp OTP proves the number → no invite needed.
  - Email OTP proves only the email → also needs an **invite code** from an existing user.
  - If no OTP sender is configured on the server → **invite-only** sign-up.
- New device login → PIN + OTP. Known device → PIN only.
- Forgot PIN → OTP → new PIN.
- Settings → **Invite friend** (one-time code, 7 days, optionally locked to friend's number).
- Brute-force limits on PIN and OTP; OTP resend limits.
- Server setup: see `OTP_SETUP.md`. Threat model: `SECURITY.md`.

## Server data / migration
- User schema is backward compatible (phone stays the key). Old v1.0/v1.1 accounts keep working with PIN-only
  login but are unverified. Recommended: wipe the Belmo data (redeploy on fresh disk) so everybody re-registers with OTP.
- New files in `server/data/db/`: `invites.json`, `pending.json`.

## Tests
- `node tests/auth-otp.js` → 28/28 PASS (OTP register/login/reset, invites, lockouts, invite-only fallback, bootstrap invite) using dev-mode senders.
- `tests/server-smoke.js` → 9/9 PASS (chat relay, E2EE blind server, call signaling).
- Headless UI E2E: register via WhatsApp OTP → chats → create invite (screens `05`–`07`).
- NOT live-tested: real Brevo/Gmail/WhatsApp delivery (needs the owner's keys; SMTP ports are blocked from the build box).

## Belmo
- Push to GitHub `main`. If Belmo auto-deploy is off: Belmo dashboard → service → **Redeploy**.
- Then add OTP env vars (`OTP_SETUP.md`) + `LINKO_BOOTSTRAP_INVITE` and redeploy again.
