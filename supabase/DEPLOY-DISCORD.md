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
