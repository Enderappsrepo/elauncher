# cf-proxy

An authenticated CurseForge relay for the **paid modpack hosting** flow, so a
customer can buy a CurseForge-modpack server without owning a CurseForge API key.

The shared key can't ship in the desktop app (an Electron asar is trivially
unpacked) or sit on the game-server box (the store's pack search runs in the
customer's browser and can't reach it). It lives here as a Supabase secret and
is injected server-side.

## What calls it

- **The store** (`docs/manage/index.html` → `cfSearch`) — a signed-in customer
  searching CurseForge modpacks when placing an order.
- **The provisioner** (`src/main/services/hostingOrders.ts` → `hostingCfAccess`)
  — the hosting box resolving the pack file + its mods when it builds the order.

The desktop app's own CurseForge browsing (create-server dialog, server mod
browser, instance installs) does **not** use this — it uses each user's personal
key from Settings. See `CfAccess` in `src/main/services/mods.ts`.

## Guardrails

So this can't become an open CurseForge proxy for the whole internet (which would
drain the shared quota or get the key banned):

1. Every request must carry a real signed-in launcher user's JWT — the bare anon
   key resolves to no user and is rejected (`/auth/v1/user` check).
2. Only the endpoints the flow needs are forwarded: `GET /mods/search`,
   `GET /mods/{id}`, `GET /mods/{id}/files[/{fileId}]`, `POST /mods/files`.

Actual jar downloads go straight to public forgecdn and never touch this proxy.

## Deploy

```sh
supabase functions deploy cf-proxy --project-ref noodzwrbsibogeoukvye
supabase secrets set CURSEFORGE_API_KEY=<your key> --project-ref noodzwrbsibogeoukvye
```

`verify_jwt` stays at its default (true): the gateway rejects malformed tokens
before the function runs, and the function rejects the anon role. `SUPABASE_URL`
and `SUPABASE_ANON_KEY` are injected automatically by the Functions runtime — you
only set `CURSEFORGE_API_KEY`.

To rotate the key, re-run the `secrets set` line — no redeploy needed.
