# Linko OTP setup (free, no SMS)

Set these as **Environment Variables** on Belmo (service → Environment), then **Redeploy**.
Check: `curl https://linko-018a.onbelmo.uk/api/health` → `"otpChannels":["whatsapp","email"]`.

## 0. Always (public server)
| Var | Value |
|---|---|
| `LINKO_BOOTSTRAP_INVITE` | any secret, e.g. `ZAIB-7Q2K-91XA` — needed for the very first account on an empty server |

## 1. Email OTP — pick ONE

### A. Brevo (recommended: free 300 emails/day, no card, works over HTTPS)
1. Sign up at https://www.brevo.com (free plan).
2. Senders, Domains & IPs → Senders → add + verify your email (e.g. your Gmail).
3. SMTP & API → API Keys → Generate.
4. Env: `BREVO_API_KEY=<key>`, `MAIL_FROM=<verified sender email>`, `MAIL_FROM_NAME=Linko`

### B. Gmail SMTP (free, ~500/day)
1. Google Account → Security → turn on 2-Step Verification.
2. Security → App passwords → create "Linko" → copy the 16-char password.
3. Env: `SMTP_HOST=smtp.gmail.com`, `SMTP_PORT=587`, `SMTP_USER=<you>@gmail.com`, `SMTP_PASS=<app password>`, `SMTP_FROM=Linko <you@gmail.com>`
   (Some hosts block SMTP ports; if codes don't arrive use Brevo.)

## 2. WhatsApp OTP (proves phone ownership)
Uses Meta's official **WhatsApp Cloud API**. Signing up is free; Meta gives a free test number. Note: Meta bills
"authentication" template messages per message in many countries (Pakistan included) after the free allowance —
check current pricing in Meta Business → WhatsApp → Pricing. No card is needed to use the test number with up to 5 test recipients.
1. https://developers.facebook.com → My Apps → Create app → type **Business** → add product **WhatsApp**.
2. WhatsApp → API Setup: copy **Phone number ID**. (Test number works for up to 5 verified recipients; add your own number for production.)
3. WhatsApp Manager → Message templates → Create → Category **Authentication**, name `linko_otp`, language English (US), include the **Copy code** button → submit (approval is usually minutes).
4. Business Settings → Users → System users → add (Admin) → Generate token with `whatsapp_business_messaging` + `whatsapp_business_management` → copy (permanent token).
5. Env: `WA_TOKEN=<token>`, `WA_PHONE_NUMBER_ID=<id>`, `WA_TEMPLATE_NAME=linko_otp`, `WA_TEMPLATE_LANG=en_US`
   (`WA_TEMPLATE_BUTTON=0` only if your template has no copy-code button.)

Why not CallMeBot / other "free WhatsApp" APIs? CallMeBot can only message the API-key owner's own number (it can't send codes to your users) and unofficial gateways see every code — insecure.

## 3. Optional policy knobs
- `LINKO_REQUIRE_INVITE=1` — invites for everyone, even with WhatsApp OTP.
- `LINKO_EMAIL_SIGNUP_NO_INVITE=1` — allow email-only sign-up without invite (weaker: email doesn't prove phone).

## Notes
- Without any of the above, the server runs **invite-only** (existing user → Settings → Invite friend).
- Belmo's free disk may reset on redeploy: users/chats/invites live in `server/data/`. Attach a persistent volume if available.
- Local testing only: `LINKO_MAIL_DEV=1` / `LINKO_WA_DEV=1` print codes to the server log instead of sending.
