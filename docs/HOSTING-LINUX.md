# Hosting ELauncher headless on a Linux VPS

A Linux VPS is roughly **half the price** of a Windows one — no OS license, and it
runs game servers efficiently without a desktop. ELauncher now has a **headless
mode** so its host services (cloud relay, provisioner, server management) run with
no window. You manage everything exactly like the Windows setup: from the
web/phone panel at `/manage/`.

> **Status:** headless mode and Linux Palworld support are new and were developed
> on Windows — they compile and follow the standard Linux patterns, but they have
> **not yet been tested on a live Linux box**. Minecraft hosting (pure Java) is the
> safest to try first; validate Palworld before relying on it. Report anything that
> misbehaves and it's a quick fix.

---

## 1. Rent a Linux VPS

- **Ubuntu 24.04 LTS** (or 22.04 / Debian 12) is the easiest target.
- Size RAM to what you'll run: Minecraft ≈ 4 GB each, Palworld ≈ 16 GB, plus ~1 GB
  for the OS (Linux's overhead is far smaller than Windows).
- SSD/NVMe storage, ≥ 40 GB.
- Contabo / Hetzner give the best RAM-per-dollar.

SSH in: `ssh root@YOUR_VPS_IP`

---

## 2. Install prerequisites

```bash
# python3 and tar are what GE-Proton needs — see "ARK: Survival Ascended" below.
# Both are already present on a stock Ubuntu 24.04; this is belt-and-braces.
apt update && apt install -y git curl xvfb tar python3

# Node 20 (build toolchain)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Electron's runtime libraries (headless still needs these present)
# (Ubuntu 22.04 / Debian 12: the audio lib is named libasound2 there, not libasound2t64)
apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 \
  libgtk-3-0 libasound2t64 libxshmfence1 libxdamage1 libxrandr2 libxcomposite1

# SteamCMD's 32-bit runtime (Palworld and other Steam servers), plus ACL tools
# ELauncher uses to run game servers as an unprivileged user. ELauncher also
# installs these itself when provisioning as root, so this line is belt-and-braces.
apt install -y lib32gcc-s1 acl

# a JRE is only needed if you skip ELauncher's managed Java; it downloads its own
```

`xvfb` provides a virtual display — Electron needs a display to start even when it
opens no window.

---

## 3. Get ELauncher onto the box

```bash
git clone https://github.com/Enderappsrepo/elauncher.git
cd elauncher
npm ci
npm run build      # produces ./out (main + preload + renderer)
```

---

## 4. Configure the headless host

Headless mode is turned on with `ELAUNCHER_HEADLESS=1`, and it signs into your
cloud account from environment variables the first time (the session then
persists, so you can remove the password afterward).

Create `/etc/elauncher.env`:

```ini
ELAUNCHER_HEADLESS=1
ELAUNCHER_EMAIL=you@example.com
ELAUNCHER_PASSWORD=your-elauncher-cloud-password
```

Use your **admin** cloud account — the same one the web panel and the provisioner
use.

### Who builds paid orders

A headless box is a **hosting node**: it watches approved orders and builds the
servers customers pay for. A desktop launcher is not, even signed into the same
admin account — so you can run the launcher at home to play without it building
a second copy of every order alongside the VPS.

Override with `ELAUNCHER_HOSTING_NODE=1` (make a desktop provision too) or `=0`
(stand a headless box down and leave it running only the servers it already has).
Hosting servers of your own is unaffected either way; this gates order
provisioning only.

Run as many hosting nodes as you like. Each order is claimed by one node before
it's built, and the claim is re-checked before the finished server is attached,
so an order is never built twice no matter how many boxes are online. A node that
dies mid-build releases its claim after ten minutes and another picks the order
up. **This needs the fleet migration** — run the latest `supabase/schema.sql`
before updating the hosts, or they'll keep provisioning unclaimed (and you'll get
a push notification saying so).

---

## 5. Run it as a service (systemd)

Create `/etc/systemd/system/elauncher.service`:

```ini
[Unit]
Description=ELauncher headless host
After=network-online.target

[Service]
WorkingDirectory=/root/elauncher
EnvironmentFile=/etc/elauncher.env
# pin the data dir to /root/.config — without this it can land in /tmp, which is
# often noexec (breaks the Java runtime) and wiped on reboot (loses worlds)
Environment=HOME=/root
Environment=XDG_CONFIG_HOME=/root/.config
# xvfb-run gives Electron a virtual display; --no-sandbox is required as root;
# --disable-gpu because there is no GPU behind Xvfb (see notes — without it the
# host FATALs every couple of minutes)
ExecStart=/usr/bin/xvfb-run -a /root/elauncher/node_modules/.bin/electron ./out/main/index.js --headless --no-sandbox --disable-gpu
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Server data (worlds, configs, your login) lives in `/root/.config/elauncher-data/`.

Then:

```bash
systemctl daemon-reload
systemctl enable --now elauncher
journalctl -u elauncher -f        # watch it start; look for "hosting active"
```

You should see `signed in as <you> (admin) — hosting active`. Your servers now
appear Online in the panel, and the provisioner runs here.

---

## 6. Open the firewall

A VPS has a real public IP — no UPnP/tunnel needed. Just open the game ports:

```bash
apt install -y ufw
ufw allow OpenSSH
ufw allow 25565/tcp        # Minecraft (one per server port)
ufw allow 8211/udp         # Palworld (one per server port)
ufw enable
```

Also open the same ports in your provider's cloud firewall if it has one. The
join address is `YOUR_VPS_IP:PORT`.

---

## 7. Manage it

Everything else is identical to Windows:

- Order/approve and manage servers from `https://enderappsrepo.github.io/elauncher/manage/`.
- Console, settings, players, mods, automation, and the rebuild flow all work over
  the relay.
- **Admin → Capacity** (in the panel/launcher) shows this box's headroom.
- Automation (restarts, backups, crash-restart, memory guard) runs on the VPS.

To update the launcher later:

```bash
cd /root/elauncher && git pull && npm ci && npm run build && systemctl restart elauncher
```

---

## 8. Notes & gotchas

- **`--disable-gpu` is not optional.** Without it the host dies every couple of
  minutes with `FATAL:electron_browser_main_parts.cc:527] Failed to shutdown.`
  and `exited with signal SIGTRAP`, and systemd restarts it. Electron still
  starts a GPU process under Xvfb, where there is no GPU for it to talk to, and
  when that process goes down it takes the browser process with it. On an empty
  box this only looks untidy in the journal; once the box is hosting, the
  graceful-shutdown handler stops and restarts every running game server on each
  cycle. Confirmed on Ubuntu 24.04 / Electron 43, 2026-07-22.

- **Palworld on Linux** installs the Linux depot via SteamCMD (`steamcmd_linux.tar.gz`)
  and launches `PalServer.sh`. SteamCMD's binary is 32-bit — without `lib32gcc-s1`
  it dies with exit 127 ("provisioning failed: SteamCMD exited with code 127").
  ELauncher now installs `lib32gcc-s1` itself when it runs as root and pre-places
  `~/.steam/sdk64/steamclient.so` for the game server; on a non-root or non-apt
  host, install `lib32gcc-s1` manually and retry.
- **Palworld refuses to run as root** (`Refusing to run with the root privileges.`
  in the console). ELauncher handles this on root hosts automatically: it creates
  a system user `elauncher-game` (home `/var/lib/elauncher-game`), chowns the
  server's folder to it, grants it traverse-only ACLs down through
  `/root/.config/elauncher-data`, and starts the game via `setpriv` as that user.
  The host itself stays root (firewall + apt still work). Needs `setpriv`
  (util-linux, preinstalled) and `setfacl` (`acl` package — auto-installed via
  apt when missing).
- **ARK: Survival Evolved** has a native Linux server and needs nothing special,
  beyond room for a ~20 GB download and roughly 8 GB of RAM at rest.
- **ARK: Survival Ascended has no Linux server build.** ELauncher runs its Windows
  binary under **GE-Proton**, which it downloads once (~400 MB, into
  `~/.config/elauncher-data/proton`) the first time an ASA server is installed.
  That needs `python3` and `tar` on the host — both stock on Ubuntu 24.04.
  - Budget disk for it: the game is ~30 GB, plus Proton and a Wine prefix per
    server (`<serverfolder>/protonprefix`). `df -h` before ordering.
  - The **first start is slow twice over** — Proton builds the Wine prefix, then
    ARK does its own long startup. The console says so when it happens; don't
    read the quiet stretch as a hang.
  - Proton is pinned to whatever release was current when the first ASA server
    was installed, so a later GE-Proton regression can't change a working server.
    Delete the `proton` folder to move to a newer build.
- **Minecraft** is pure Java and the most reliable to start with — prove the whole
  pipeline (order → provision → manage → play) with a Minecraft server first.
- **Security:** don't run as root long-term for a real business; create a dedicated
  user, restrict SSH to keys, and keep the box updated. Running as root here keeps
  the guide short.
- **This is new code paths** — if a server won't provision or stop cleanly on Linux,
  grab the `journalctl -u elauncher` output and it's a targeted fix.
