# ELauncher

A custom Minecraft launcher for you and your friends: Microsoft login, Fabric/Forge/NeoForge, a Modrinth + CurseForge mod browser, shareable modpacks, and a cloud modpack library with one-click install and update.

**Download:** [enderappsrepo.github.io/elauncher](https://enderappsrepo.github.io/elauncher/) · [latest release](https://github.com/Enderappsrepo/elauncher/releases/latest)

## Development

```bash
npm install
npm run dev          # run in development with hot reload
npm run typecheck    # type-check main + renderer
npm run dist         # build the Windows installer (electron-builder)
```

## Cloud setup (accounts + modpack library)

The cloud features (ELauncher accounts, admin-published modpacks, one-click install/update) are powered by a free [Supabase](https://supabase.com) project. One person (you) sets this up once; friends just sign up inside the app.

1. Create a project at [supabase.com](https://supabase.com) (free tier is plenty).
2. In the dashboard, open **SQL Editor -> New query**, paste the entire contents of [`supabase/schema.sql`](supabase/schema.sql), and click **Run**.
3. Recommended: in **Authentication -> Sign In / Up -> Email**, turn **off** "Confirm email" so friends can sign in right after signing up.
4. In **Project Settings -> API**, copy the **Project URL** and the **anon public** key into [`src/shared/cloudConfig.ts`](src/shared/cloudConfig.ts):

```ts
export const SUPABASE_URL = 'https://yourproject.supabase.co'
export const SUPABASE_ANON_KEY = 'eyJ...'
```

5. Rebuild/redistribute the launcher. Sign up inside the app, then make yourself an admin by running this in the SQL editor:

```sql
update public.profiles set is_admin = true
where id = (select id from auth.users where email = 'you@example.com');
```

Admins get a **Publish to cloud** action on every instance; everyone else sees the published packs in the **Modpacks** page and can install/update them with one click.

The anon key is safe to embed in the shipped app — Row Level Security in the schema is what controls access (only signed-in users can read packs, only admins can publish).

## Releases & auto-update

Installed copies of ELauncher update themselves: the app checks this repo's GitHub releases on
startup (`electron-updater`), downloads new versions in the background, and installs on restart.
The portable exe can't swap itself, so it shows a "get the update" link instead.

To ship a new version:

```bash
npm version patch        # bumps package.json and creates the vX.Y.Z tag
git push --follow-tags   # the Release workflow builds + publishes the installer
```

The [Release workflow](.github/workflows/release.yml) builds the Windows installer and uploads it
(plus `latest.yml`, the update feed) to a GitHub release. You can also publish from your machine
with `GH_TOKEN=<token> npm run release`.

## Website

The landing page at [enderappsrepo.github.io/elauncher](https://enderappsrepo.github.io/elauncher/)
lives in [`docs/`](docs/) and is served by GitHub Pages. Its download buttons always point at the
newest release automatically (via the GitHub API), so shipping a release updates the site too.
