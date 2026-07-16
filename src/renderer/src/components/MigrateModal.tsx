import { useEffect, useState } from 'react'
import type { MigrationCandidate, SourceLauncher } from '@shared/types'
import { useToast } from '../toast'
import { IconAlert, IconBox } from '../icons'

interface Props {
  onClose: () => void
  onImported: (instanceId: string) => void
}

const LAUNCHER_LABELS: Record<SourceLauncher, string> = {
  curseforge: 'CurseForge',
  modrinth: 'Modrinth App',
  vanilla: 'Official launcher'
}

const PARTS: { key: 'mods' | 'configs' | 'options' | 'servers' | 'resourcePacks' | 'worlds'; label: string }[] = [
  { key: 'mods', label: 'Mods' },
  { key: 'configs', label: 'Mod configs' },
  { key: 'options', label: 'Options & keybinds' },
  { key: 'servers', label: 'Server list' },
  { key: 'resourcePacks', label: 'Resource packs' },
  { key: 'worlds', label: 'Worlds (can be large)' }
]

export default function MigrateModal({ onClose, onImported }: Props): React.JSX.Element {
  const toast = useToast()
  const [candidates, setCandidates] = useState<MigrationCandidate[] | null>(null)
  const [selected, setSelected] = useState<MigrationCandidate | null>(null)
  const [parts, setParts] = useState({
    mods: true,
    configs: true,
    options: true,
    servers: true,
    resourcePacks: true,
    worlds: false
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])

  useEffect(() => {
    window.elauncher.migrate
      .scan()
      .then(setCandidates)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  const doImport = async (): Promise<void> => {
    if (!selected) return
    setBusy(true)
    setError(null)
    try {
      const instance = await window.elauncher.migrate.import({ path: selected.path, ...parts })
      toast.success(`Imported "${selected.name}" from ${LAUNCHER_LABELS[selected.launcher]}`)
      onImported(instance.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={() => !busy && onClose()}>
      <div className="modal" style={{ maxWidth: 620 }} onClick={(e) => e.stopPropagation()}>
        <h2>Migrate from another launcher</h2>
        <p className="muted small" style={{ margin: '-6px 0 4px' }}>
          Bring your instances over from CurseForge, the Modrinth App, or the official launcher — mods,
          settings, keybinds, servers and worlds included.
        </p>
        {error && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        {candidates === null ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : candidates.length === 0 ? (
          <div className="empty-state" style={{ padding: '28px 0' }}>
            <div className="empty-icon">
              <IconBox size={24} />
            </div>
            <h2 style={{ fontSize: 16 }}>Nothing found</h2>
            <p>No CurseForge, Modrinth App, or official-launcher data was found on this computer.</p>
          </div>
        ) : (
          <>
            <div className="field">
              <label>Found instances</label>
              <div className="mod-list" style={{ maxHeight: 260, overflowY: 'auto' }}>
                {candidates.map((c) => (
                  <button
                    key={c.path}
                    className="mod-row"
                    style={{
                      textAlign: 'left',
                      width: '100%',
                      cursor: 'pointer',
                      border: selected?.path === c.path ? '1px solid var(--accent)' : undefined
                    }}
                    onClick={() => setSelected(c)}
                  >
                    <div className="info">
                      <h4>{c.name}</h4>
                      <div className="meta">
                        <span>{LAUNCHER_LABELS[c.launcher]}</span>
                        {c.minecraftVersion && <span>{c.minecraftVersion}</span>}
                        <span>{c.loader}</span>
                        {c.modCount > 0 && <span>{c.modCount} mods</span>}
                        {c.hasWorlds && <span>has worlds</span>}
                      </div>
                    </div>
                  </button>
                ))}
              </div>
              {selected && !selected.minecraftVersion && (
                <div className="hint" style={{ color: 'var(--yellow)' }}>
                  Could not detect this instance's Minecraft version — it will be created with the latest
                  release. You can change it afterwards in the instance settings.
                </div>
              )}
            </div>
            <div className="field">
              <label>What to bring over</label>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                {PARTS.map((p) => (
                  <label key={p.key} className="checkbox-row">
                    <input
                      type="checkbox"
                      checked={parts[p.key]}
                      onChange={(e) => setParts((prev) => ({ ...prev, [p.key]: e.target.checked }))}
                    />
                    {p.label}
                  </label>
                ))}
              </div>
            </div>
          </>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            disabled={busy || !selected || !Object.values(parts).some(Boolean)}
            onClick={() => void doImport()}
          >
            {busy ? 'Importing…' : 'Import instance'}
          </button>
        </div>
      </div>
    </div>
  )
}
