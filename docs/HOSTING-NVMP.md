# NV:MP co-op hosting with customer-supplied files

ELauncher can provision an NV:MP instance on an existing **x64 Linux** hosting
node using GE-Proton. Paid NV:MP orders now create a stopped server and share it
with the customer **before any retail game files are supplied**. The hosting
operator does not need a shared Fallout: New Vegas installation or Data template
for these orders.

The public server is a Windows program. Offline tests cover installation,
transfer, validation, permissions and lifecycle handling, but a live Linux boot
and external client join are still required before selling an active plan.

## Introductory plan and database update

The chosen introductory plan is **$6 USD/month**, with **10 players, 4 GB RAM
and 2 shared CPU cores**. It fits the existing $4–$7 small-server catalog. Capacity
and support costs still need measuring with real NV:MP workloads.

For an existing database, run `supabase/migrations/2026-10-30-nvmp-plan.sql` in
Supabase SQL Editor after updating the Linux host. It adds the allowed game and
fixed-slot constraints, inserts active plan `nvmp-10`, and refreshes the API schema.
This makes the plan orderable and replaces the Coming soon preview automatically.
Re-running it preserves an existing plan's price, visibility and payment settings.
It uses the existing manual-payment flow; it does not create a Stripe product.

Fresh installs receive the same seed through `supabase/schema.sql`. All earlier
game constraints in that file also allow NV:MP, so rerunning the full schema no
longer fails when an NV:MP plan already exists.

## Customer flow in the web panel

1. Once the host approves/provisions the order, open the server in `/manage/`.
   Its order note says **Waiting for your game files**.
2. Open **Game setup** and choose the **Data** folder from the customer's own
   Fallout: New Vegas installation. Use a desktop browser with folder selection
   such as Chrome or Edge. Select Data itself, not the entire game installation.
3. Click **Upload game files**. Nested folders are preserved. Progress shows bytes
   transferred, percentage and the current file. Keep the page open. Pause is
   available; navigating away also stops new chunks. Requests already in flight
   may take up to a minute to settle.
4. After an interruption or browser restart, reselect the same Data folder and
   click **Resume upload**. The host retains a per-file chunk bitmap, so only
   missing chunks are sent. Changed selections require discarding the unfinished
   upload first. File size, modification time and a bounded content sample identify
   the reselected files; every transferred chunk has a SHA-256 checksum.
5. Import `plugins_override.txt` or enter one plugin filename per line in the
   load-order box, starting with `FalloutNV.esm`. Include the DLCs/mods the group
   uses, in exactly the same order as the clients. Use plain filenames, without
   directory paths or leading asterisks. Filename case must match the Data files.
6. Click **Validate files and finish setup**. Missing, duplicate or unsafe plugin
   paths keep setup unfinished with a specific error. Correct the load order and
   retry; the uploaded Data does not need to be sent again.
7. Click **Start server**. Players join through the matching NV:MP launcher using
   **Connect via IP**, with the published address and assigned port.

To replace files later, stop the server, choose the new Data folder and repeat.
Existing Data is kept until the replacement has uploaded and validated. Discarding
an unfinished replacement restores availability of the previous installation.
Setup does not launch a game automatically.

## Transfer limits and access

- 64 GB total per setup, 16 GB per file, at most 10,000 files. Uploads stream in
  512 KB chunks with four requests in flight; large BSA files are never buffered
  in full in the browser. This bypasses the ordinary Files tab's 100 MB limit.
- Transfers use the existing authenticated hosting relay. No new public upload
  port, web server or cloud bucket is required. Large folders can take substantial
  time over this transport; this is not a direct high-speed file-transfer service.
- The host checks available disk space before beginning. Provision enough space
  for each customer's Data, pending replacements and backups. Uploads are not
  shared as templates or copied into other customer instances.
- Only the host, an admin, or the account renting the instance can change setup.
  Invited panel users may inspect its status. Existing server access checks still
  apply to every request.
- Executables and native plugins (including DLL/ASI files) are excluded from the
  folder selection and refused by the endpoint. The panel lists exclusions.
  Native plugins that the group requires need host assistance; the upload wizard
  handles game data and assets, not arbitrary executable plugins.
- Traversal, case-colliding filenames, symlinks, cross-server sessions, invalid
  offsets, incomplete chunks and changed retries are rejected. Generic Files
  routes cannot read upload bookkeeping or follow Wine's filesystem links.
- Completed upload requests clear their binary payload from the relay row.
  Progress remains in the server's `.nvmp-upload` directory until completion or
  discard. There is no automatic deletion of an unfinished customer's upload;
  use **Discard unfinished upload** to reclaim that space.

## Host setup and deployment

Use the headless node described in [HOSTING-LINUX.md](HOSTING-LINUX.md). Proton
requires `python3` and `tar`; privilege separation uses the existing game user,
`setpriv`, and ACL tools. The inspected NV:MP 9.43 story server is a 32-bit Windows
executable importing MSVCP140/VCRUNTIME140 and the Windows CRT. Verify the installed
Proton build supplies these during the live boot test.

Paid orders set `nvmpCustomerFiles: true`. Linux eligibility is checked before
claiming an order; neither provisioning nor startup uses a global game template.
ELauncher downloads the official pinned **9.43** distribution, checks its SHA-256,
and extracts only the story server, OpenSSL libraries and README. It downloads
Proton if the node has no existing managed runtime. No SteamCMD account is needed.

Each instance has its own Data, upload session, load order, Proton prefix and
Steam compatibility directory. On a root host the game runs as the existing
unprivileged game user without the hosting account's environment secrets.

Both **TCP and UDP** must be reachable on the assigned port, initially **27015**.
Open both in the VPS provider firewall as well as the OS firewall. No TCP-only
relay can carry this game's traffic. Co-op has a fixed **10-player** cap, no join
password setting and no remote admin console. The in-game console toggle controls
player cheats. Progress saves live on clients; host backups contain Data, the
load order, config and version metadata, not player saves. Native plugin support
and the 4 GB RAM planning hint must be evaluated with the group's actual setup.

Before enabling sales:

1. Deploy the reviewed host and web builds during the normal maintenance window.
   The upload feature adds relay actions but requires no new database migration
   beyond the NV:MP game/10-slot constraints. The `2026-10-30-nvmp-plan.sql`
   migration combines those constraints with the chosen introductory plan.
2. Use a private/inactive 10-slot test plan while validating the host.
   Test one approved order: it should become manageable while stopped and waiting
   for customer files, without `ELAUNCHER_NVMP_ROOT` configured.
3. Upload real customer-provided files through the browser. Test pause/resume,
   load-order validation, discard, and replacement. Confirm another customer's
   login cannot access that server or its upload.
4. Start the test instance. Wait for its actual listening log and join from an
   external network with matching DLCs, mods, load order and NV:MP version.
   Check movement, combat, saving/rejoining, player counts, stop/restart, and two
   simultaneous instances. Monitor disk/RAM and verify backup/restore while stopped.
5. Run `2026-10-30-nvmp-plan.sql` to list the $6 introductory plan after those
   checks succeed. Merely deploying source files does not execute this SQL.

### Optional operator template for manually created servers

The existing desktop/manual flow remains available: set `ELAUNCHER_NVMP_ROOT` to
an absolute directory containing `Data/`, `plugins_override.txt`, and optionally
`server.cfg`. Templates must contain real files, not links. This path is used only
when `nvmpCustomerFiles` is absent/false. Paid customer instances always ignore it.

## Updates and validation

Clients and server must use matching versions. Update the pinned NV:MP version,
checksum and extracted-file allowlist deliberately, repeat tests and the live
join check, then stop existing servers before replacing verified server binaries.
Preserve their customer Data, load order, config and upload state. There are no
silent binary or customer-file updates.

```text
node scripts/test-nvmp.mjs
node scripts/test-nvmp-upload.mjs
npm run typecheck
npm run build
npm run web:build
```

Optionally set `NVMP_TEST_ARCHIVE` to the already downloaded official 9.43 ZIP for
package installation checks. Tests do not download or start games. Upload tests
exercise the browser transfer functions against the real host handlers with
synthetic files, including interruption, retry, file isolation and commit recovery.
Disk-capacity fixtures are deterministic and include a low-space refusal test.
Live browser-to-cloud throughput and Linux game compatibility remain deployment
validation tasks.

Sources inspected on 2026-10-30:

- [Official co-op hosting guide](https://nuwiki.nv-mp.com/wiki/Hosting_CO:OP)
- [Official 9.43 distribution](https://github.com/NVMP/ClientDistribution/releases/tag/9.43)
- The distribution's server README, executable imports, configuration keys and
  log strings. Static inspection alone cannot establish Linux compatibility.
