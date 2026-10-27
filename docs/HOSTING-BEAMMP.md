# BeamNG.drive hosting with BeamMP

ELauncher runs the official BeamMP dedicated server for BeamNG.drive. It installs
the latest stable upstream binary; the hosting machine does not need a copy of
BeamNG.drive. Players launch their game through the BeamMP client and use its
Direct Connect screen, or the public BeamMP server list when listing is enabled.

## Supported hosts

- Ubuntu 22.04 or 24.04; Debian 12 or 13.
- Linux x86-64 or ARM64, using the exact distribution/architecture release asset.
- Windows x64 is also supported. macOS hosting is not supported by this provider.

On Debian/Ubuntu install BeamMP's runtime dependency:

```bash
sudo apt-get update
sudo apt-get install -y liblua5.3-0
```

Windows needs the Microsoft Visual C++ Redistributable required by the official
BeamMP release. Downloads are selected from the official stable GitHub release,
size checked, and verified against its SHA-256 digest when GitHub supplies one.

## Upgrade an existing hosting platform

1. Update every hosting node before enabling BeamMP plans. From the ELauncher
   checkout, install dependencies and build the new host code with `npm ci` and
   `npm run build`. The usual Linux service installation is documented in
   [HOSTING-LINUX.md](HOSTING-LINUX.md).
2. Run [the BeamMP migration](../supabase/migrations/2026-10-27-beammp-hosting.sql)
   in the existing Supabase project's SQL editor. Fresh installs use the updated
   `supabase/schema.sql`. The migration does not create plans or set prices.
3. Restart the `elauncher` hosting service during a maintenance window. ELauncher
   stops its running game servers when the host exits; it does not hot reload.
4. Publish the dashboard using `npm run web:build:dashboard` and the repository's
   existing `main`/`docs` GitHub Pages configuration.
5. In dashboard **Admin → New plan**, choose **BeamNG.drive (BeamMP)** and enter
   your own player slots, RAM/CPU allowance and monthly price. New plans start
   hidden. List a plan only after the hosting node and database are updated.
   Target its first order at the intended upgraded VPS when using a fleet.

The new BeamMP-only claim RPC keeps ordinary older hosts from claiming a BeamMP
order as Minecraft. A host left running an earlier legacy migration fallback
must still be upgraded before plans are enabled. Both initial claims and lease
renewals use `hosting_claim_beammp`; completing an order always uses the existing
ownership fence. A missing migration fails closed for BeamMP.

## Create and start a server

For local hosting, choose **BeamNG.drive (BeamMP)** in the launcher's New server
dialog. For customer hosting, approve an order against a BeamMP plan. The host
downloads BeamMP, creates the resource folders and shares the stopped server
with the customer.

Open **Settings**, enter a unique authentication key from
[BeamMP Keymaster](https://keymaster.beammp.com/), save, then press **Start**.
BeamMP requires a key even for an unlisted/private server. Use one key per
concurrent server; do not paste it into an order note, console or support message.
Blank key input preserves the configured key. The dashboard reports only whether
a key is configured and clears it from processed relay-request history.

Keys are stored with private file permissions under
`elauncher-data/server-secrets/<server-id>.beammp.key`, outside the server folder,
SFTP root, backups and folder ZIP exports. BeamMP runs with
`BEAMMP_PROVIDER_DISABLE_CONFIG=true` and managed environment settings: an
environment-only key without that flag would be written back into
`ServerConfig.toml` by the upstream server.

Settings support name, description, stock/custom map path, player count, cars
per player, listing, guests and log options. Player slots are capped by the
hosting plan. A private server is unlisted, not password protected. Hosted
servers enable automatic startup after their first successful authenticated
start; they are not reported Ready merely because a process was spawned.

## Network, mods and console

The default port is **30814**, with **both TCP and UDP on the same port**. Each
additional server gets a free port. Allow the allocated port in the VPS provider's
firewall and the operating system firewall; for example:

```bash
sudo ufw allow 30814/tcp
sudo ufw allow 30814/udp
```

Do not use the Minecraft TCP relay for BeamMP: gameplay also requires UDP.
The Network tab shows both transports and allows changing a stopped BeamMP
server's port after checking both protocols for conflicts.

- Upload intact vehicle/map ZIPs into `Resources/Client` using Files or SFTP.
- Put server-side Lua plugins in folders under `Resources/Server`.
- Change maps using a path such as `/levels/gridmap_v2/info.json` in Settings.
- Use `help`, `status`, `list`, `say <message>`, `kick <name>` or `reloadmods` in
  the Console. ELauncher sends `exit` for graceful shutdown.
- Automated backups include Resources and nonsecret ELauncher settings.
  Restoring them keeps the separately stored authentication key.

A real join test needs an issued key, the running VPS and a BeamMP client.
Automated tests cover official asset selection, checksum failures, settings and
key isolation, Windows/Linux process arguments, readiness/player logs, shutdown,
provisioning lifecycle and real PostgreSQL migration/lease behavior.

```bash
npm run typecheck
npm run test:beammp
```

The optional SQL test uses test-only PGlite installed outside this project:

```bash
npm install --prefix ../beammp-db-tests --ignore-scripts @electric-sql/pglite
ELAUNCHER_TEST_MODULES="$(realpath ../beammp-db-tests/node_modules)" npm run test:beammp:schema
```

Official references: [server setup](https://docs.beammp.com/server/create-a-server/),
[server manual](https://docs.beammp.com/server/manual/),
[configuration and maps](https://docs.beammp.com/server/server-maintenance/), and
[upstream releases/source/license](https://github.com/BeamMP/BeamMP-Server).
The provider downloads unmodified upstream binaries rather than redistributing
BeamNG game files.
