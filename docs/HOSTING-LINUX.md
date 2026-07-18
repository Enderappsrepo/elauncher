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
apt update && apt install -y git curl xvfb tar

# Node 20 (build toolchain)
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt install -y nodejs

# Electron's runtime libraries (headless still needs these present)
# (Ubuntu 22.04 / Debian 12: the audio lib is named libasound2 there, not libasound2t64)
apt install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 \
  libgtk-3-0 libasound2t64 libxshmfence1 libxdamage1 libxrandr2 libxcomposite1

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
# xvfb-run gives Electron a virtual display; --no-sandbox is required as root
ExecStart=/usr/bin/xvfb-run -a /root/elauncher/node_modules/.bin/electron ./out/main/index.js --headless --no-sandbox
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

- **Palworld on Linux** installs the Linux depot via SteamCMD (`steamcmd_linux.tar.gz`)
  and launches `PalServer.sh`. If it fails to start, the usual cause is missing
  32/64-bit libs — install `lib32gcc-s1` and the Steam runtime deps and retry.
- **Minecraft** is pure Java and the most reliable to start with — prove the whole
  pipeline (order → provision → manage → play) with a Minecraft server first.
- **Security:** don't run as root long-term for a real business; create a dedicated
  user, restrict SSH to keys, and keep the box updated. Running as root here keeps
  the guide short.
- **This is new code paths** — if a server won't provision or stop cleanly on Linux,
  grab the `journalctl -u elauncher` output and it's a targeted fix.
