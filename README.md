# ELauncher

A custom Minecraft launcher for you and your friends: Microsoft login, Fabric/Forge/NeoForge, a Modrinth + CurseForge mod browser, shareable modpacks, and a cloud modpack library with one-click install and update.

**Download:** [enderappsrepo.github.io/elauncher](https://enderappsrepo.github.io/elauncher/) · [latest release](https://github.com/Enderappsrepo/elauncher/releases/latest)

## Development

```bash
npm install
npm run dev          # run in development with hot reload
npm run typecheck    # type-check main + renderer
npm run test:folder-downloads # ZIP export, transfer, access and cleanup regressions
npm run dist         # build the Windows installer (electron-builder)
```

## Downloading server folders

In the hosting panel's **Files** tab, open a folder's actions and choose
**Download ZIP**. Selected folders also download as ZIPs using the selection
bar's **Download** button. Each archive includes its folder, nested files and
empty subfolders; selected regular files keep their usual downloads.

Stop the game server before exporting a world so its files stay consistent.
Folder exports allow up to 100 MB of source files and a 100 MB ZIP, matching
the panel's existing transfer limit. Use SFTP for larger folders. Downloads
leave the original folder untouched. Updated hosts refuse symbolic links and
remove temporary host ZIPs after transfer or six hours without use.

The dashboard also works with older hosting launchers by downloading the folder
through their existing file APIs and creating the ZIP in the browser. Updated
hosts prepare the ZIP on the host before transferring it.

Build only the live hosting dashboard with `npm run web:build:dashboard`. This
updates `docs/manage/` and its assets while preserving the landing page and guides.

## NVMP Companion

`companion/` is a separate portable Windows app for NV:MP hosting customers. It
signs in with their ELauncher account, finds their Fallout: New Vegas install and
load order, and uploads the Data folder to their server through the same relay
protocol as the panel's **Game setup** tab. See
[docs/HOSTING-NVMP.md](docs/HOSTING-NVMP.md#companion-app).

```bash
npm run companion:dev    # run it with hot reload
npm run companion:dist   # build release-companion/ELauncher-NVMP-Companion.exe
npm run test:companion   # offline tests: host upload handlers, Release workflow, download links
```

It has its own appId and no update feed. The Release workflow builds it in a job of
its own that both launcher platform jobs wait for, so a broken companion stops the
whole release before anything is published. The Windows job attaches the exe to the
launcher's release after publishing, only when the release tag is the checked-out
commit; it never touches `latest.yml`. The landing page and the panel link to the exe
only once the latest release carries it; when GitHub's API cannot be reached, both
link to the releases list instead. Publish the landing page alone with
`npm run web:build:landing`, as `web:build:dashboard` does for `docs/manage/`.

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
