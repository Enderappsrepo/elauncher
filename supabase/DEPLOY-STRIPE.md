# Card payments (Stripe Checkout) — one-time setup

Card checkout is optional per plan: a plan with a `stripe_price_id` gets the
automated flow (pay by card → order activates itself → a hosting node builds
the server), plans without one keep the manual flow (PayPal/link + "I've paid"
+ your approval in Admin). Nothing breaks if you never do this setup — the
shop just won't offer cards.

## 1. Stripe side

1. Create a [Stripe](https://dashboard.stripe.com) account (or use test mode
   first — everything below works the same with test keys).
2. **Products**: create one product per plan you want card-payable (e.g.
   "Minecraft Basic"), each with a **recurring monthly price** matching the
   plan's `price_monthly`. Copy each **price id** (`price_…`).
3. **Webhook**: Developers → Webhooks → Add endpoint:
   - URL: `https://<project-ref>.supabase.co/functions/v1/stripe-webhook`
   - Events: `checkout.session.completed`, `invoice.paid`,
     `customer.subscription.deleted`
   - Copy the **signing secret** (`whsec_…`).
4. Copy your **secret key** (`sk_live_…` / `sk_test_…`) from Developers → API
   keys.

## 2. Supabase side

```bash
# migration (also safe to paste into the SQL editor)
#   supabase/migrations/2026-07-22-stripe-checkout.sql

supabase functions deploy stripe-checkout --project-ref <ref>
supabase functions deploy stripe-webhook --no-verify-jwt --project-ref <ref>

supabase secrets set STRIPE_SECRET_KEY=sk_... --project-ref <ref>
supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_... --project-ref <ref>
```

`--no-verify-jwt` is required on the webhook only: Stripe calls it without a
Supabase JWT, and the Stripe signature check inside is what authenticates it.
`stripe-checkout` keeps JWT verification on.

## 3. Attach prices to plans

In the SQL editor:

```sql
update public.hosting_plans set stripe_price_id = 'price_...' where id = 'mc-basic';
-- repeat per plan; leave it null on plans that should stay manual-payment
```

## 4. Verify

1. Open the panel shop, order a card-enabled plan → "Pay by card" appears on
   the receipt.
2. Pay with Stripe's test card `4242 4242 4242 4242` (any future date/CVC).
3. You land back on the panel with "Payment received"; within ~15s the order
   flips to **active** (Billing), and a hosting node starts building. The
   Stripe dashboard's webhook page shows the delivery as `200`.

Renewals: each `invoice.paid` pushes the order's `paid_until` out another
cycle. A customer cancelling in Stripe simply stops renewals — the server runs
out its paid time and the host suspends it as `past_due`, worlds kept, same as
the manual flow.
