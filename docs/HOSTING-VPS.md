# Hosting ELauncher on a Windows VPS

This guide moves your game servers off your home PC and onto a rented Windows
server that runs 24/7. Your ELauncher app runs on the VPS as the **host**; you
manage everything from your phone or the web panel. Nothing runs on your own PC.

It works with **zero code changes** because ELauncher and the Palworld dedicated
server are both Windows software — a Windows VPS runs your exact setup.

---

## 1. Rent a Windows VPS

Pick a provider that offers **Windows Server** images:

| Provider | Good for |
| --- | --- |
| **Contabo** | Cheapest RAM — best value for Palworld's ~16 GB appetite |
| **Vultr** | Polished, hourly billing (test for ~$1/night) |
| **OVHcloud** | Includes DDoS protection (matters for public game servers) |
| **Kamatera / Amazon Lightsail** | Flexible / predictable, Lightsail pricier |

**Specs to choose:**

- **RAM** is the deciding cost. Rule of thumb: one Palworld server ≈ 16 GB;
  a Minecraft server ≈ 4 GB. Pick RAM = (what you'll run) + 4 GB for Windows.
  - Just a couple of Minecraft servers → **8–16 GB**
  - One Palworld server → **16 GB**
  - A small hosting business → **32 GB** and up
- **OS:** Windows Server 2022 (2019 is fine too).
- **Storage:** SSD/NVMe, at least 80 GB (Palworld's server files are ~8 GB, plus
  worlds and backups).
- **Region:** closest to your players for low ping.
- Confirm the provider **allows game-server hosting** (most do; a few budget
  hosts restrict it).

Rough cost: a 16 GB Windows VPS runs ~$30–60/month (the Windows license adds a
premium over Linux). Hourly-billed providers let you test cheaply first.

---

## 2. Connect with Remote Desktop

The provider gives you an **IP address, username (usually `Administrator`), and
password**.

1. On your PC, open **Remote Desktop Connection** (search "mstsc").
2. Enter the VPS IP, connect, and sign in with the provided credentials.
3. You now have a Windows desktop running in the cloud.

> **Leaving servers running:** when you're done, **disconnect** (close the RDP
> window) — do **not** "Sign out". On Windows Server, disconnecting keeps your
> session and all running servers alive. Signing out stops them.

---

## 3. Secure it first (do this before anything else)

This machine has a public IP — lock it down:

1. **Change the Administrator password** to something long and unique.
2. **Windows Firewall** — open only what you need:
   - Restrict **RDP (TCP 3389)** to *your* home IP if possible (Windows Firewall
     → Inbound Rules → Remote Desktop → Scope → Remote IP).
   - Allow your game ports inbound: **TCP 25565** (Minecraft), **UDP 8211**
     (Palworld). Add a rule per server port you use.
3. Turn on **automatic Windows Updates** (but see §6 about reboots).
4. Also open the same game ports in your **provider's firewall/security group**
   if they have one (Vultr, OVH, AWS all have a separate cloud firewall).

---

## 4. Install ELauncher

On the VPS:

1. Get the installer — either:
   - Download `ELauncher-Setup-x.y.z.exe` from your GitHub releases page, **or**
   - Build it on your PC with `npm run dist` and copy the file over (you can
     drag-and-drop through the RDP window).
2. Run the installer. (If SmartScreen warns about an unknown publisher, click
   **More info → Run anyway** — same as any unsigned app until you code-sign it.)
3. Launch ELauncher.

Because the tunnel is a native protocol client (no downloaded helper binary) and
SteamCMD is Valve-signed, **Windows Defender has nothing to flag** here.

---

## 5. Sign in and go live

1. In ELauncher, **sign into your admin cloud account** (same account as the web
   panel). This is what lets the host publish status and run the provisioner.
2. Your existing servers/orders sync from the cloud. Approve an order (or create
   a server) and watch it install **on the VPS**.
3. Confirm it's reachable: because a VPS has a **real public IP with open ports**,
   there's no router/UPnP step — the join address is simply
   **`<your VPS IP>:<port>`**. Share that with players. (In the launcher's invite
   card, the public IP it detects *is* the VPS IP.)
4. From now on, manage it all from your **phone/web panel** at
   `https://enderappsrepo.github.io/elauncher/manage/` — the VPS just has to stay
   on.

---

## 6. Keep it running unattended

You want servers to survive reboots (e.g., after Windows Update) without you
RDP-ing in:

1. **Auto-login after reboot** — so the desktop session starts on its own:
   - Run `netplwiz`, uncheck "Users must enter a user name and password", enter
     the Administrator password. (This is the standard unattended-server setup;
     it means anyone with console access is logged in — fine for a dedicated
     host, and RDP is still password-protected.)
2. **Start ELauncher on login** — put a shortcut to ELauncher in the startup
   folder: press `Win+R`, type `shell:startup`, drop a shortcut there.
3. **Start servers on launch** — in each server's **Automation** tab, enable
   **"Start this server when the launcher opens."**
4. Optionally schedule Windows Updates for a low-traffic hour so the reboot lands
   when nobody's playing; the chain above brings everything back automatically.

After a reboot: Windows auto-logs in → ELauncher auto-starts → flagged servers
auto-start. Fully hands-off.

---

## 7. Run it day to day

- **Monitor from anywhere:** the web/phone panel shows live status, console,
  players, and performance. The launcher's **Admin → Capacity** tab shows memory
  headroom and how many more servers your VPS can handle.
- **Automation does the babysitting:** scheduled restarts, rolling backups,
  crash auto-restart, and the memory-guard restart all run on the VPS.
- **Updating the launcher:** its self-updater pulls new releases; or reinstall
  the newer `Setup.exe`.
- **Backups:** they land in each server's folder under `backups/`. For safety,
  occasionally copy them off the VPS (or use the provider's snapshot feature).

---

## 8. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Panel shows **"PC offline"** | The VPS launcher isn't signed into the cloud, or the VPS is off / the app closed. RDP in, make sure ELauncher is running and signed in. |
| Players can't connect | Port not open. Check **both** Windows Firewall and the provider's cloud firewall for that TCP/UDP port. |
| Servers stopped after you left | You "Signed out" of RDP instead of disconnecting. Disconnect (close the window) next time; set up §6 auto-start. |
| Palworld install slow | The ~8 GB SteamCMD download uses VPS bandwidth — normal, give it a few minutes. |
| Everything died after an update reboot | Set up auto-login + startup + auto-start (§6). |

---

## Cost reality & the cheaper alternative

A 24/7 16 GB Windows VPS (~$30–60/mo) makes sense once you have paying customers,
or if you just want your home PC free and don't mind the cost. For a few friends
it may be more than you need.

The **cheaper path is a Linux VPS** (~half the price on Contabo/Hetzner), but it
needs launcher changes: a windowless "headless" host mode and Linux
Palworld-server support. If the Windows bill feels steep, ask and that Linux
build is on the table.
