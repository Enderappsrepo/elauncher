# Discord bot — one-time setup

The bot puts the whole application flow inside a guild: members run `/apply`
and answer an invite link's questions in a modal, moderators approve or deny
with buttons in a review channel (or in the panel — same queue), a yes can
grant a role and DMs the join instructions, and a denied applicant may appeal
once. It is an HTTP-interactions app: Discord POSTs to an edge function and it
replies, so **nothing runs anywhere** — no gateway process, no VPS daemon.

Nothing else breaks if you skip this — invite links and the web application
flow work without it. The panel's Access → Discord card just stays in its
"deploy the function" state.

## 1. Discord side

1. [discord.com/developers/applications](https://discord.com/developers/applications)
   → **New Application** (name it what players should see, e.g. "ELauncher").
2. From **General Information** copy the **Application ID** and **Public Key**.
3. **Bot** tab → copy the **Token** (Reset Token if it's hidden). No
   privileged intents are needed — leave them all off.
4. Don't set the Interactions Endpoint URL yet — the function must be
   deployed first, because Discord verifies the URL the moment you save it.

## 2. Supabase side

Migrations first (SQL editor, in this order — the first two may already be
run):

```
supabase/migrations/2026-07-22-invites-and-applications.sql
supabase/migrations/2026-07-22-discord-bot.sql
supabase/migrations/2026-07-22-discord-claims.sql
```

Then the function and its secrets:

```bash
supabase functions deploy discord-bot --no-verify-jwt --project-ref <ref>

supabase secrets set DISCORD_PUBLIC_KEY=... --project-ref <ref>
supabase secrets set DISCORD_APP_ID=... --project-ref <ref>
supabase secrets set DISCORD_BOT_TOKEN=... --project-ref <ref>
```

`--no-verify-jwt` is required: Discord calls without a Supabase JWT, and the
Ed25519 signature check inside the function is what authenticates it (bad
signatures get 401). Panel calls to the same function still authenticate —
each route checks its caller's JWT or the service key itself.

## 3. Point Discord at it

Back in the application's **General Information**, set

```
Interactions Endpoint URL:
https://<project-ref>.supabase.co/functions/v1/discord-bot
```

Discord sends a signed PING when you save; if saving fails, the function
isn't deployed, the URL is wrong, or `DISCORD_PUBLIC_KEY` doesn't match.

## 4. Register the slash commands

Once, from any shell (service role key, **not** the anon key):

```bash
curl -X POST https://<project-ref>.supabase.co/functions/v1/discord-bot \
  -H "Authorization: Bearer <service-role-key>" \
  -H "Content-Type: application/json" \
  -d '{"kind":"register"}'
```

Expect `{"ok":true,"commands":["apply","status","setup"]}`. Global commands
can take a few minutes to appear in clients; re-running is harmless (it
overwrites the same list).

## 5. Link a guild

1. Panel → your server → **Access** → **Discord** → "add the bot to your
   Discord" (the link appears once the function is deployed; you need Manage
   Server in the guild you pick).
2. In that guild, run **/setup** — it answers privately with a claim code.
3. Paste the code into the same Discord card. The code — minted only for
   members with Manage Server — is what proves the guild is yours to link;
   it expires in 30 minutes and re-running /setup mints a fresh one.
4. Configure the card: which invite link `/apply` asks (its questions are the
   form, its approval message is the DM a yes sends), the role to grant, the
   review channel, appeals on or off.

**The one Discord gotcha:** the bot can only grant roles that sit *below its
own role* in Server Settings → Roles. The panel marks unassignable roles and
the bot says so in the review channel if it happens anyway — drag the bot's
role up and it heals.

## 6. Verify

1. `/apply` in the guild → the modal shows your questions → submit.
2. The application lands in the review channel with Approve/Deny buttons and
   in the panel's Access queue — both act on the same row.
3. Approve → the applicant gets a DM with the approval message and the role;
   deny with a reason → the DM carries the reason and (if allowed) an Appeal
   button, and the appeal comes back to both queues marked amber.

Applicants who block DMs still get their answer from `/status` — the bot
notes the failed DM in the review channel either way.

## Alternative: host the bot on a VPS (gateway mode)

Discord can deliver interactions two ways: POSTed to a public HTTPS URL
(everything above), or pushed down a websocket the bot opens itself. A
bare-IP VPS can't do the first — Discord requires a valid-certificate HTTPS
URL — so `vps/discord-gateway.ts` provides the second: a small shim that
connects out to the gateway, runs the *same* `discord-bot/index.ts` as a
local child, signs each incoming interaction with its own boot-time keypair,
and relays the child's response back through the interaction callback. Same
handler, different transport; nothing is forked or rewritten.

What changes against the steps above:

- **Skip step 3's JWT toggle and step 5 entirely.** Leave the app's
  **Interactions Endpoint URL empty** — with no URL set, Discord delivers
  over the gateway. (If you already set a URL, clear it, or the websocket
  never receives interactions.)
- **Skip step 6** — the shim registers the slash commands itself each boot.
- **Keep the Supabase function deployed** (step 2/4): the panel's routes
  (claim redeem, role/channel dropdowns, decision side-effects) still run
  there, and in this mode its JWT verification can stay **on**.

On the VPS (Ubuntu; needs Deno — `curl -fsSL https://deno.land/install.sh |
DENO_INSTALL=/usr/local sh`):

```bash
mkdir -p /opt/elauncher-discord /etc/elauncher
cp vps/discord-gateway.ts supabase/functions/discord-bot/index.ts /opt/elauncher-discord/
cp vps/discord-bot.service /etc/systemd/system/
cp vps/discord-bot.env.example /etc/elauncher/discord-bot.env && chmod 600 /etc/elauncher/discord-bot.env
# fill DISCORD_BOT_TOKEN, DISCORD_APP_ID, SUPABASE_SERVICE_ROLE_KEY in the env file, then
systemctl daemon-reload && systemctl enable --now discord-bot
journalctl -u discord-bot -f   # expect "ready as <botname>" and a command-registration line
```

`deno run --allow-net --allow-env --allow-run /opt/elauncher-discord/discord-gateway.ts --selftest`
verifies the shim→function path without touching Discord. A bad token exits
with code 78 and stays down (systemd's `RestartPreventExitStatus`) instead of
hammering Discord's login endpoint — fix the env file and `systemctl start`
again.
