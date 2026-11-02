# Email delivery setup (Resend)

SaaS Shield sends account emails through Resend. This page covers what must be
configured for **real users** to receive mail, and how to prove it works.

## The rule that bites: the shared test sender

`EMAIL_FROM="SaaS Shield <onboarding@resend.dev>"` is Resend's shared test
sender. It only delivers to **the address on the Resend account**. Every other
recipient is rejected by Resend with HTTP 403:

> You can only send testing emails to your own email address (...) To send emails
> to other recipients, please verify a domain at resend.com/domains, and change
> the `from` address to an email using this domain.

The application now reports that rejection honestly instead of claiming the mail
was sent, but it cannot bypass it. Verification is a provider-side requirement.

## 1. Verify a sending domain

1. Resend dashboard -> Domains -> **Add Domain** (for example `send.example.com`).
2. Resend shows the exact DNS records for that domain, typically an SPF `TXT`
   record, a DKIM `TXT` record (or CNAME) and an optional `MX` record for
   bounces. **Copy the values Resend shows at that moment.** They are unique to
   the domain and account; this repository cannot and does not invent them.
3. Add those records at your DNS provider and wait for Resend to show
   **Verified**. Verification usually takes minutes and can take longer while DNS
   propagates.
4. Prefer a subdomain (`send.example.com`) so the root domain's existing mail
   records are untouched.

## 2. Set the environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| `EMAIL_PROVIDER` | yes | `resend` |
| `RESEND_API_KEY` | yes | Sending-only scope is enough. Server-side only, never in the frontend or the repo. |
| `EMAIL_FROM` | yes | `SaaS Shield <alerts@send.example.com>` once the domain is verified. |
| `PUBLIC_BASE_URL` | yes | Public origin used in verification links, e.g. `https://saas-shield.onrender.com`. |
| `RESEND_WEBHOOK_SECRET` | for delivery tracking | `whsec_...` from the Resend webhook you create in step 3. |

`GET /api/auth/config` reports the effective state (`configured`, `provider`,
`from`, `test_sender`, `delivery_tracking`) without revealing any secret.

## 3. Delivery-status webhooks

1. Resend -> Webhooks -> **Add Webhook**.
2. Endpoint URL: `https://<your-host>/api/webhooks/resend`
3. Subscribe to: `email.sent`, `email.delivered`, `email.delivery_delayed`,
   `email.bounced`, `email.complained`.
4. Copy the signing secret into `RESEND_WEBHOOK_SECRET` and redeploy.

Without the secret the endpoint answers `503 webhook_not_configured` on purpose:
an unsigned event cannot be distinguished from a forgery. Signatures are Svix
(`svix-id`, `svix-timestamp`, `svix-signature`), verified over the raw body in
constant time with a 5 minute tolerance. Events are matched to `email_outbox` by
provider message id, and ordering is enforced so a retried `email.sent` never
overwrites a later `delivered`/`bounced`.

## 4. The three states, and what each one means

| State | Meaning | Where to look |
| --- | --- | --- |
| Accepted | Resend returned a message id. Nothing more. | `email_outbox.status = sent`, `provider_message_id` set |
| Delivered / bounced / complained | Resend's own post-delivery report | `email_outbox.status`, `delivered_at`, `last_event` (needs webhooks) |
| Verification used | The recipient clicked the link and the account is confirmed | `users.email_verified_at`, `email_verification_tokens.used_at` |

The UI never upgrades "accepted" to "sent" or "delivered" on its own.

## 5. Verify it yourself

```
curl -s https://<host>/api/auth/config          # provider/test_sender/delivery_tracking
node tools/resend-check.js you@your-domain.tld  # one real send through app code
```

`tools/resend-check.js` prints the classified result (`sent` / `failed` with an
error code) and records the attempt in `email_outbox`.
