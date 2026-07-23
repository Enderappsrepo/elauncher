-- Stripe Checkout beside the manual links.
--
-- A plan that carries a stripe_price_id gets a real card checkout: the
-- stripe-checkout edge function opens a Stripe Checkout session for the order,
-- and the stripe-webhook function activates the order when Stripe reports the
-- payment — no operator approval step, the provisioner just sees an active
-- order and builds it. Plans without a price id keep today's flow (PayPal /
-- payment link + "I've paid" + human review), which is also the fallback while
-- the functions or secrets are not deployed yet.
--
-- No new policies: both functions run with the service role. Customers still
-- cannot touch status/paid_until themselves — hosting_mark() remains the only
-- customer-reachable transition.

alter table public.hosting_plans add column if not exists stripe_price_id text;

alter table public.hosting_orders add column if not exists stripe_session_id text;
alter table public.hosting_orders add column if not exists stripe_subscription_id text;

-- renewals arrive as subscription events, so the webhook looks orders up by
-- subscription rather than by id
create index if not exists hosting_orders_stripe_subscription
  on public.hosting_orders (stripe_subscription_id)
  where stripe_subscription_id is not null;
