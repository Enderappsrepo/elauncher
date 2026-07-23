# Email — one-time setup for order + application mail

Two functions share one mail setup: `invite-mail` (application receipts and
decisions) and `order-mail` (order placed / paid / server ready / past due).
Configure the secrets once and both send; configure nothing and both flows
still work — the panel is always the source of truth, mail just makes it
timely.

## 1. Pick a provider (either, or both)

- **Brevo** — fastest to working email: free account, confirm one sender
  address, no DNS. 300 mails/day. Grab an API key (SMTP & API → API keys).
- **Resend** — the better sender long-term, but it requires a **verified
  domain** (DNS records) before it will send to customers. If both keys are
  set, Resend wins.

Optional: a Discord webhook (channel settings → Integrations → Webhooks) gets
you operator pings — new orders and new applications — with no mail provider
at all.

## 2. Deploy + secrets

```bash
supabase functions deploy order-mail --project-ref <ref>
supabase functions deploy invite-mail --project-ref <ref>

supabase secrets set INVITE_MAIL_FROM="ELauncher Hosting <mail@yourdomain>" --project-ref <ref>
supabase secrets set INVITE_SITE_URL="https://enderappsrepo.github.io/elauncher" --project-ref <ref>
supabase secrets set BREVO_API_KEY=xkeysib-... --project-ref <ref>     # and/or:
supabase secrets set RESEND_API_KEY=re_... --project-ref <ref>
supabase secrets set INVITE_DISCORD_WEBHOOK=https://discord.com/api/webhooks/... --project-ref <ref>
```

With Brevo, `INVITE_MAIL_FROM`'s address must be the sender you confirmed.

## 3. What sends when

| Email | Trigger | Sent by |
| --- | --- | --- |
| Order receipt (reference + how to pay) | customer places an order | shop, in the browser |
| Payment received, server being built | Stripe webhook fires, or you approve in Admin | webhook / panel |
| Server ready + join address | a hosting node finishes the build | the host process |
| Paused, world kept, renew to revive | paid time lapses | the host process |
| Application received / decided | invite flow | panel + invite page |

The host-sent ones (`ready`, `past_due`) start firing once the boxes restart
into a build containing this change.

## 4. Verify

Place a test order → the receipt lands (check spam the first time); approve
it → the paid mail; when the node finishes → the ready mail with the address.
Every send is best-effort: a mail failure never blocks an order, a build, or
a decision.
