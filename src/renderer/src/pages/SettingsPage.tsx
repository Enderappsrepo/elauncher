import { useEffect, useState } from 'react'
import type { Settings } from '@shared/types'
import { useToast } from '../toast'
import { setTheme, useTheme } from '../theme'
import { IconDownload, IconMoon, IconRefresh, IconSun } from '../icons'
import { useAppVersion, useUpdater } from '../updates'

/** Launcher version + self-update controls. */
function UpdatesCard(): React.JSX.Element {
  const status = useUpdater()
  const version = useAppVersion()
  const [checking, setChecking] = useState(false)

  const check = async (): Promise<void> => {
    setChecking(true)
    try {
      await window.elauncher.updates.check()
    } finally {
      setChecking(false)
    }
  }

  const line = ((): React.JSX.Element | string => {
    switch (status?.state) {
      case 'dev':
        return 'Running from source — packaged builds update themselves from GitHub releases.'
      case 'checking':
        return 'Checking for updates…'
      case 'uptodate':
        return "You're on the latest version."
      case 'available':
        return status.portable
          ? `v${status.version} is out. The portable build can't update in place — grab the new exe below.`
          : `v${status.version} found — downloading…`
      case 'downloading':
        return `Downloading v${status.version ?? ''} — ${Math.round(status.percent ?? 0)}%`
      case 'ready':
        return `v${status.version} is downloaded. It installs when you restart (or quit) the launcher.`
      case 'error':
        return <span style={{ color: 'var(--red)' }}>Update check failed: {status.error}</span>
      default:
        return 'Updates are checked automatically a few seconds after launch.'
    }
  })()

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <h2 style={{ fontSize: 15, fontWeight: 700 }}>Updates</h2>
      <div className="switch-row" style={{ alignItems: 'center' }}>
        <div>
          <div className="switch-title">ELauncher {version ? `v${version}` : ''}</div>
          <div className="switch-desc">{line}</div>
        </div>
        {status?.state === 'ready' ? (
          <button className="primary" onClick={() => void window.elauncher.updates.install()}>
            <IconRefresh size={14} /> Restart to update
          </button>
        ) : status?.state === 'available' && status.portable ? (
          <button className="primary" onClick={() => void window.elauncher.updates.openLatest()}>
            <IconDownload size={14} /> Download
          </button>
        ) : (
          <button
            className="ghost"
            disabled={checking || status?.state === 'checking' || status?.state === 'downloading'}
            onClick={() => void check()}
          >
            <IconRefresh size={14} /> Check now
          </button>
        )}
      </div>
      {status?.state === 'downloading' && (
        <div className="progress-track">
          <div
            className="progress-fill"
            style={{ width: `${Math.max(0, Math.min(100, status.percent ?? 0))}%` }}
          />
        </div>
      )}
      {(status?.state === 'available' || status?.state === 'ready') && status.notes && (
        <div className="hint" style={{ whiteSpace: 'pre-wrap' }}>
          {status.notes}
        </div>
      )}
    </div>
  )
}

function SwitchRow({
  title,
  desc,
  checked,
  onChange
}: {
  title: string
  desc: string
  checked: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label className="switch-row">
      <div>
        <div className="switch-title">{title}</div>
        <div className="switch-desc">{desc}</div>
      </div>
      <span className="switch">
        <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
        <span className="knob" />
      </span>
    </label>
  )
}

export default function SettingsPage(): React.JSX.Element {
  const toast = useToast()
  const [theme] = useTheme()
  const [settings, setSettings] = useState<Settings | null>(null)

  useEffect(() => {
    window.elauncher.settings.get().then(setSettings).catch(console.error)
  }, [])

  if (!settings) {
    return (
      <div>
        <div className="page-header">
          <h1>Settings</h1>
        </div>
        <div className="skeleton" style={{ height: 300, maxWidth: 560 }} />
      </div>
    )
  }

  const save = async (): Promise<void> => {
    const next = await window.elauncher.settings.set(settings)
    setSettings(next)
    toast.success('Settings saved')
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p className="muted small" style={{ marginTop: 2 }}>
            Global defaults — individual instances can override memory and Java options.
          </p>
        </div>
      </div>
      <div style={{ maxWidth: 620, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Appearance</h2>
          <div className="field">
            <label>Theme</label>
            <div className="segmented" style={{ maxWidth: 300 }}>
              <button className={theme === 'dark' ? 'active' : ''} onClick={() => setTheme('dark')}>
                <IconMoon size={14} /> Dark
              </button>
              <button className={theme === 'light' ? 'active' : ''} onClick={() => setTheme('light')}>
                <IconSun size={14} /> Light
              </button>
            </div>
            <div className="hint">Switch between the dark and light Nebula themes — applies instantly.</div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Performance</h2>
          <SwitchRow
            title="Optimized Java flags"
            desc="Tuned garbage collector + pre-allocated heap. Reduces stutter a lot on modded packs. Skipped automatically if an instance picks its own GC in extra JVM arguments."
            checked={settings.optimizedJvmFlags ?? true}
            onChange={(v) => setSettings({ ...settings, optimizedJvmFlags: v })}
          />
          {(settings.optimizedJvmFlags ?? true) && (
            <div className="field">
              <label>Garbage collector</label>
              <div className="segmented">
                {(
                  [
                    { id: 'auto', label: 'Auto' },
                    { id: 'zgc', label: 'ZGC' },
                    { id: 'g1', label: "G1 (Aikar's)" }
                  ] as const
                ).map((o) => (
                  <button
                    key={o.id}
                    className={(settings.jvmGc ?? 'auto') === o.id ? 'active' : ''}
                    onClick={() => setSettings({ ...settings, jvmGc: o.id })}
                  >
                    {o.label}
                  </button>
                ))}
              </div>
              <div className="hint">
                Auto uses ZGC on Java 21+ (Minecraft 1.20.5 and newer) — smoothest for mods like Distant
                Horizons — and Aikar's G1 tuning on older versions.
              </div>
            </div>
          )}
          <SwitchRow
            title="Automatic memory"
            desc="Sizes the game's RAM from your system (up to 8 GiB for modded, 4 GiB for vanilla). Applies to instances that don't set their own memory limit."
            checked={settings.autoMemory ?? true}
            onChange={(v) => setSettings({ ...settings, autoMemory: v })}
          />
          <SwitchRow
            title="Higher process priority"
            desc="Runs the game above-normal so background apps steal fewer frames. Turn off if other apps (Discord, OBS) get sluggish while playing."
            checked={settings.highProcessPriority ?? false}
            onChange={(v) => setSettings({ ...settings, highProcessPriority: v })}
          />
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Game defaults</h2>
          <div className="field">
            <label>Default max memory (MiB)</label>
            <input
              type="number"
              min={1024}
              step={512}
              value={settings.defaultMemoryMax}
              disabled={settings.autoMemory ?? true}
              onChange={(e) => setSettings({ ...settings, defaultMemoryMax: Number(e.target.value) || 4096 })}
            />
            <div className="hint">
              {(settings.autoMemory ?? true)
                ? 'Not used while Automatic memory is on. Instances can still set their own limit.'
                : "Used by instances that don't set their own memory limit."}
            </div>
          </div>
          <div className="field">
            <label>Global Java path override</label>
            <input
              value={settings.javaPath ?? ''}
              placeholder="Leave empty to auto-download the right Java per version"
              onChange={(e) => setSettings({ ...settings, javaPath: e.target.value || undefined })}
            />
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Mod sources</h2>
          <div className="field">
            <label>CurseForge API key</label>
            <input
              type="password"
              value={settings.curseforgeApiKey ?? ''}
              placeholder="Optional — needed to browse CurseForge"
              onChange={(e) => setSettings({ ...settings, curseforgeApiKey: e.target.value || undefined })}
            />
            <div className="hint">
              Get a free key at console.curseforge.com. Modrinth works out of the box without any key.
            </div>
          </div>
        </div>

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          <h2 style={{ fontSize: 15, fontWeight: 700 }}>Server hosting</h2>
          <div className="field">
            <label>Per-server hostname pool</label>
            <textarea
              rows={4}
              value={settings.hostPool ?? ''}
              placeholder={'emberpeak.duckdns.org\nstormvale.duckdns.org\none hostname per line'}
              onChange={(e) => setSettings({ ...settings, hostPool: e.target.value || undefined })}
            />
            <div className="hint">
              Each hosted server claims one name, so every customer sees their own address instead of your shared IP.
              Create free names at duckdns.org (up to 5 per account) and list them here; a server keeps its name until
              it&apos;s deleted. The launcher checks hourly that the names still point at you and warns if one drifts.
            </div>
          </div>
          <div className="field">
            <label>DuckDNS token</label>
            <input
              type="password"
              value={settings.duckdnsToken ?? ''}
              placeholder="Optional — from your duckdns.org account page"
              onChange={(e) => setSettings({ ...settings, duckdnsToken: e.target.value || undefined })}
            />
            <div className="hint">
              Lets the launcher keep your .duckdns.org names pointed at this connection automatically, even when your
              ISP changes your IP.
            </div>
          </div>
          <div className="field">
            <label>Fallback public address</label>
            <input
              value={settings.publicHost ?? ''}
              placeholder="e.g. play.yourdomain.com — leave empty to use your public IP"
              onChange={(e) => setSettings({ ...settings, publicHost: e.target.value || undefined })}
            />
            <div className="hint">
              Used when a server has no pool name. Point a DNS A record (or your router&apos;s Dynamic DNS) at this
              connection first. Tunnel (bore.pub) addresses are unaffected.
            </div>
          </div>
        </div>

        <UpdatesCard />

        <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div className="switch-title">Support ELauncher ♥</div>
          <div className="switch-desc">
            The launcher is free and stays that way — sponsorships keep the cloud (accounts, remote management,
            notifications) running.
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <a className="ghost small" style={{ textDecoration: 'none' }} href="https://github.com/sponsors/Enderappsrepo" target="_blank" rel="noreferrer">
              Sponsor on GitHub
            </a>
            <a className="ghost small" style={{ textDecoration: 'none' }} href="https://github.com/Enderappsrepo/elauncher" target="_blank" rel="noreferrer">
              Star the project
            </a>
          </div>
        </div>

        <div className="row">
          <button className="primary" onClick={() => void save()}>
            Save settings
          </button>
        </div>
      </div>
    </div>
  )
}
