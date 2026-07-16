import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { CopySettingsRequest, Instance, InstalledMod, JarModInfo, ModUpdateInfo, PackLink } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { formatBytes, formatPlaytime, timeAgo } from '../fmt'
import { useInstanceCover } from '../useCover'
import {
  IconBox,
  IconClock,
  IconCloud,
  IconCopy,
  IconDownload,
  IconExport,
  IconFolder,
  IconGlobe,
  IconImage,
  IconLink,
  IconPlay,
  IconPlus,
  IconRefresh,
  IconSearch,
  IconServer,
  IconSliders,
  IconStop,
  IconTrash
} from '../icons'
import Menu from '../components/Menu'
import PublishPackModal from '../components/PublishPackModal'
import CoverPickerModal from '../components/CoverPickerModal'
import ContentTab from '../components/ContentTab'
import WorldsTab from '../components/WorldsTab'
import ServersTab from '../components/ServersTab'
import GameSettingsTab from '../components/GameSettingsTab'
import PerformanceTab from '../components/PerformanceTab'
import Select from '../components/Select'

type Tab = 'mods' | 'performance' | 'shaders' | 'resourcepacks' | 'worlds' | 'servers' | 'game' | 'logs' | 'settings'

const TABS: { id: Tab; label: string }[] = [
  { id: 'mods', label: 'Mods' },
  { id: 'performance', label: 'Performance' },
  { id: 'shaders', label: 'Shaders' },
  { id: 'resourcepacks', label: 'Resource Packs' },
  { id: 'worlds', label: 'Worlds' },
  { id: 'servers', label: 'Servers' },
  { id: 'game', label: 'Game Settings' },
  { id: 'logs', label: 'Logs' },
  { id: 'settings', label: 'Settings' }
]

/** Friendly, actionable read of why the game crashed, from the tail of its logs. */
interface CrashHint {
  title: string
  detail: string
  /** offer a one-click jump to the Performance tab for memory-related crashes */
  perfAction?: boolean
}
function diagnoseCrash(lines: string[], errorMsg?: string): CrashHint | null {
  const text = (lines.slice(-400).join('\n') + '\n' + (errorMsg ?? '')).toLowerCase()
  if (/could not reserve enough space|the specified size exceeds the maximum|failed to allocate.*(heap|memory)/.test(text)) {
    return {
      title: 'Memory limit set too high',
      detail: "The game was told to use more RAM than your system can give it, so the JVM couldn't start. Lower this instance's memory under Performance → Engine.",
      perfAction: true
    }
  }
  if (/outofmemoryerror|out of memory|java heap space|gc overhead limit/.test(text)) {
    return {
      title: 'Ran out of memory',
      detail: 'The game needed more RAM than it was allowed. Raise this instance\'s memory under Performance → Engine, or run Optimize to add memory-saving mods like FerriteCore.',
      perfAction: true
    }
  }
  if (/unsupportedclassversionerror|compiled by a more recent version of the java|class file version/.test(text)) {
    return {
      title: 'Wrong Java version',
      detail: 'A mod or this Minecraft version needs a newer Java than was used. Clear the Java path override (Settings, or this instance\'s Settings tab) so ELauncher auto-downloads the right one.'
    }
  }
  if (/mixin|incompatiblemodsetexception|missing or unsupported mandatory dependencies|failed to load mods|is incompatible|requires .* which is missing|duplicate mod/.test(text)) {
    return {
      title: 'A mod is incompatible',
      detail: 'One of the installed mods doesn\'t match this Minecraft/loader version, is duplicated, or is missing a dependency. Open the Logs tab to find the mod name, then disable or update it in Mods.'
    }
  }
  return null
}

function InstalledModsTab({ instance }: { instance: Instance }): React.JSX.Element {
  const navigate = useNavigate()
  const toast = useToast()
  const { runStates } = useAppState()
  const [mods, setMods] = useState<InstalledMod[] | null>(null)
  const [jarInfo, setJarInfo] = useState<Record<string, JarModInfo>>({})
  const [query, setQuery] = useState('')
  const [updates, setUpdates] = useState<ModUpdateInfo[]>([])
  const [checking, setChecking] = useState(false)
  const [updating, setUpdating] = useState<string | null>(null)

  // renames/deletes fail while Windows has the jars locked by the running game
  const busy = runStates[instance.id] === 'running' || runStates[instance.id] === 'installing'

  const refresh = useCallback(() => {
    window.elauncher.mods.listInstalled(instance.id).then(setMods).catch(console.error)
    // names/icons parsed from the jars themselves, then Modrinth hash-identification
    // for anything still unknown (matches get adopted into launcher metadata)
    window.elauncher.mods
      .jarInfo(instance.id)
      .then((info) => {
        setJarInfo(info)
        return window.elauncher.mods.identify(instance.id)
      })
      .then((res) => {
        if (res.identified > 0) {
          setMods(res.mods)
          toast.success(`Matched ${res.identified} mod${res.identified === 1 ? '' : 's'} on Modrinth`)
        }
      })
      .catch(console.error)
  }, [instance.id, toast])

  useEffect(() => refresh(), [refresh])

  const checkUpdates = async (): Promise<void> => {
    setChecking(true)
    try {
      const found = await window.elauncher.mods.checkUpdates(instance.id)
      setUpdates(found)
      if (found.length === 0) toast.success('All mods are up to date')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setChecking(false)
    }
  }

  const applyUpdate = async (u: ModUpdateInfo): Promise<void> => {
    setUpdating(u.fileName)
    const result = await window.elauncher.mods.applyUpdate(instance.id, u)
    if (result.ok) toast.success(`Updated to ${u.newVersionNumber}`)
    else toast.error(result.error ?? 'Update failed')
    setUpdates((list) => list.filter((x) => x.fileName !== u.fileName))
    setUpdating(null)
    refresh()
  }

  const onToggle = async (mod: InstalledMod): Promise<void> => {
    const res = await window.elauncher.mods.toggle(instance.id, mod.fileName)
    if (!res.ok) toast.error(res.error ?? 'Could not change the mod')
    setMods(res.mods)
  }

  const onRemove = async (mod: InstalledMod): Promise<void> => {
    const res = await window.elauncher.mods.remove(instance.id, mod.fileName)
    if (!res.ok) toast.error(res.error ?? 'Could not remove the mod')
    setMods(res.mods)
  }

  const visible = useMemo(() => {
    if (!mods) return []
    const q = query.trim().toLowerCase()
    if (!q) return mods
    return mods.filter(
      (m) =>
        m.displayName.toLowerCase().includes(q) ||
        (m.title ?? '').toLowerCase().includes(q) ||
        (jarInfo[m.displayName]?.name ?? '').toLowerCase().includes(q)
    )
  }, [mods, jarInfo, query])

  if (mods === null) {
    return (
      <div className="mod-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 76 }} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 14, justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="muted small">
          {query.trim()
            ? `${visible.length} of ${mods.length} mods`
            : `${mods.length} mod${mods.length === 1 ? '' : 's'} installed`}
          {updates.length > 0 && <span style={{ color: 'var(--yellow)' }}> · {updates.length} update(s) available</span>}
        </div>
        <div className="row" style={{ flexWrap: 'wrap' }}>
          {mods.length > 0 && (
            <div className="search-wrap" style={{ width: 210 }}>
              <IconSearch size={14} />
              <input placeholder="Search mods…" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
          )}
          <button className="ghost" disabled={checking || mods.length === 0} onClick={() => void checkUpdates()}>
            <IconRefresh size={14} /> {checking ? 'Checking…' : 'Check for updates'}
          </button>
          <button className="primary" onClick={() => navigate(`/mods?instance=${instance.id}`)}>
            <IconPlus size={14} /> Browse mods
          </button>
        </div>
      </div>
      {busy && (
        <div className="hint" style={{ marginBottom: 12 }}>
          The game is using these files right now — close it to enable, disable or remove mods.
        </div>
      )}
      {mods.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <IconBox size={28} />
          </div>
          <h2>No mods installed</h2>
          <p>Use the mod browser to add mods to this instance.</p>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state" style={{ padding: '40px 20px' }}>
          <h2>No matches</h2>
          <p>No mod matches "{query.trim()}".</p>
        </div>
      ) : (
        <div className="mod-list">
          {visible.map((mod) => {
            const update = updates.find((u) => u.fileName === mod.fileName)
            const parsed = jarInfo[mod.displayName]
            const title = mod.title ?? parsed?.name ?? mod.displayName
            const icon = mod.iconUrl ?? parsed?.iconDataUrl
            const version = mod.versionNumber ?? parsed?.version
            return (
              <div className="mod-row" key={mod.fileName} style={{ opacity: mod.enabled ? 1 : 0.55 }}>
                {icon ? (
                  <img className="mod-icon" src={icon} alt="" loading="lazy" />
                ) : (
                  <div className="mod-icon-placeholder">
                    <IconBox size={20} />
                  </div>
                )}
                <div className="info">
                  <h4>{title}</h4>
                  <div className="meta">
                    {version && <span>{version}</span>}
                    <span>{formatBytes(mod.sizeBytes)}</span>
                    {mod.source && <span>{mod.source}</span>}
                    {!mod.enabled && <span style={{ color: 'var(--yellow)' }}>disabled</span>}
                  </div>
                </div>
                {update && (
                  <button
                    className="primary"
                    disabled={updating === mod.fileName || busy}
                    onClick={() => void applyUpdate(update)}
                  >
                    {updating === mod.fileName ? 'Updating…' : `Update`}
                  </button>
                )}
                <span
                  className="switch green"
                  title={busy ? 'Close the game to change mods' : mod.enabled ? 'Disable this mod' : 'Enable this mod'}
                  style={{ marginTop: 0, opacity: busy ? 0.55 : 1 }}
                >
                  <input type="checkbox" checked={mod.enabled} disabled={busy} onChange={() => void onToggle(mod)} />
                  <span className="knob" />
                </span>
                <button
                  className="icon-btn"
                  title={busy ? 'Close the game to remove mods' : 'Remove'}
                  disabled={busy}
                  onClick={() => void onRemove(mod)}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

type LogLevel = 'info' | 'warn' | 'error'
type LogFilter = 'all' | 'warn' | 'error'

function logLevel(line: string): LogLevel {
  if (/\b(ERROR|FATAL|SEVERE)\b|Exception|^\s+at /.test(line)) return 'error'
  if (/\bWARN(ING)?\b/.test(line)) return 'warn'
  return 'info'
}

/** Highlights case-insensitive matches of `query` inside a log line. */
function highlight(line: string, query: string): React.ReactNode {
  if (!query) return line
  const parts = line.split(new RegExp(`(${query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'))
  return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : part))
}

function LogsTab({ instanceId }: { instanceId: string }): React.JSX.Element {
  const [lines, setLines] = useState<string[]>([])
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState<LogFilter>('all')
  const viewRef = useRef<HTMLDivElement>(null)
  const stickToBottom = useRef(true)

  useEffect(() => {
    window.elauncher.game.getLogs(instanceId).then(setLines).catch(console.error)
    const off = window.elauncher.game.onLog((e) => {
      if (e.instanceId === instanceId) {
        setLines((prev) => [...prev.slice(-999), e.line])
      }
    })
    return off
  }, [instanceId])

  const classified = useMemo(() => lines.map((line) => ({ line, level: logLevel(line) })), [lines])
  const warnCount = classified.filter((l) => l.level === 'warn').length
  const errorCount = classified.filter((l) => l.level === 'error').length

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return classified.filter(
      (l) =>
        (filter === 'all' || l.level === filter) && (!q || l.line.toLowerCase().includes(q))
    )
  }, [classified, filter, query])

  useEffect(() => {
    if (stickToBottom.current) {
      viewRef.current?.scrollTo({ top: viewRef.current.scrollHeight })
    }
  }, [visible])

  const onScroll = (): void => {
    const el = viewRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
  }

  return (
    <div className="log-shell">
      <div className="log-toolbar">
        <div className="search-wrap">
          <IconSearch size={14} />
          <input placeholder="Filter logs…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="log-filters">
          <button className={filter === 'all' ? 'active' : ''} onClick={() => setFilter('all')}>
            All
          </button>
          <button className={`warn${filter === 'warn' ? ' active' : ''}`} onClick={() => setFilter('warn')}>
            Warnings{warnCount > 0 ? ` ${warnCount}` : ''}
          </button>
          <button className={`error${filter === 'error' ? ' active' : ''}`} onClick={() => setFilter('error')}>
            Errors{errorCount > 0 ? ` ${errorCount}` : ''}
          </button>
        </div>
      </div>
      <div className="log-view" ref={viewRef} onScroll={onScroll}>
        {lines.length === 0 ? (
          <span className="faint">No output yet. Launch the game to see logs.</span>
        ) : visible.length === 0 ? (
          <span className="faint">Nothing matches the current filter.</span>
        ) : (
          visible.map((l, i) => (
            <div key={i} className={`log-line${l.level !== 'info' ? ` ${l.level}` : ''}`}>
              {highlight(l.line, query.trim())}
            </div>
          ))
        )}
      </div>
    </div>
  )
}

const COPY_PARTS: { key: keyof Omit<CopySettingsRequest, 'fromId' | 'toId'>; label: string; hint: string }[] = [
  { key: 'options', label: 'Game options & keybinds', hint: 'options.txt — video settings, controls, sound…' },
  { key: 'servers', label: 'Server list', hint: 'servers.dat — your saved multiplayer servers' },
  { key: 'configs', label: 'Mod configs', hint: 'the config folder from the other instance' },
  { key: 'resourcePacks', label: 'Resource packs', hint: 'copies the resourcepacks folder' }
]

function CopySettingsCard({ instance }: { instance: Instance }): React.JSX.Element | null {
  const { instances } = useAppState()
  const toast = useToast()
  const others = instances.filter((i) => i.id !== instance.id)
  const [fromId, setFromId] = useState('')
  const [parts, setParts] = useState({ options: true, servers: true, configs: false, resourcePacks: false })
  const [busy, setBusy] = useState(false)

  if (others.length === 0) return null

  const copy = async (): Promise<void> => {
    setBusy(true)
    const result = await window.elauncher.instances.copySettings({ fromId, toId: instance.id, ...parts })
    setBusy(false)
    if (!result.ok) {
      toast.error(result.error ?? 'Copy failed')
    } else if (result.copied.length === 0) {
      toast.error('Nothing to copy — the other instance has none of the selected files yet.')
    } else {
      toast.success(`Copied ${result.copied.join(', ')} from "${others.find((o) => o.id === fromId)?.name}"`)
    }
  }

  return (
    <div className="card" style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <h3 style={{ margin: 0 }}>Copy settings from another instance</h3>
        <div className="hint" style={{ marginTop: 4 }}>
          Bring over your keybinds, video settings, servers and configs instead of redoing them.
        </div>
      </div>
      <div className="field">
        <label>Copy from</label>
        <Select
          value={fromId}
          onChange={setFromId}
          placeholder="Select an instance…"
          options={others.map((o) => ({ value: o.id, label: `${o.name} (${o.minecraftVersion})` }))}
        />
      </div>
      {COPY_PARTS.map((p) => (
        <label key={p.key} className="checkbox-row" title={p.hint}>
          <input
            type="checkbox"
            checked={parts[p.key]}
            onChange={(e) => setParts((prev) => ({ ...prev, [p.key]: e.target.checked }))}
          />
          <span>
            {p.label} <span className="faint small">— {p.hint}</span>
          </span>
        </label>
      ))}
      <div className="row">
        <button
          className="primary"
          disabled={busy || !fromId || !Object.values(parts).some(Boolean)}
          onClick={() => void copy()}
        >
          <IconCopy size={14} /> {busy ? 'Copying…' : 'Copy settings'}
        </button>
      </div>
    </div>
  )
}

function SettingsTab({ instance, onSaved }: { instance: Instance; onSaved: () => void }): React.JSX.Element {
  const toast = useToast()
  const [name, setName] = useState(instance.name)
  const [memory, setMemory] = useState(instance.memoryMax)
  const [jvmArgs, setJvmArgs] = useState(instance.extraJvmArgs ?? '')
  const [javaPath, setJavaPath] = useState(instance.javaPathOverride ?? '')

  const save = async (): Promise<void> => {
    await window.elauncher.instances.update({
      ...instance,
      name: name.trim() || instance.name,
      memoryMax: memory,
      extraJvmArgs: jvmArgs.trim() || undefined,
      javaPathOverride: javaPath.trim() || undefined
    })
    toast.success('Instance settings saved')
    onSaved()
  }

  return (
    <div className="card" style={{ maxWidth: 560, display: 'flex', flexDirection: 'column', gap: 18 }}>
      <div className="field">
        <label>Name</label>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label>Max memory (MiB)</label>
        <input type="number" min={0} step={512} value={memory} onChange={(e) => setMemory(Number(e.target.value) || 0)} />
        <div className="hint">0 uses the global default from Settings.</div>
      </div>
      <div className="field">
        <label>Extra JVM arguments</label>
        <input value={jvmArgs} placeholder="-XX:+UseG1GC" onChange={(e) => setJvmArgs(e.target.value)} />
      </div>
      <div className="field">
        <label>Java path override</label>
        <input
          value={javaPath}
          placeholder="Leave empty to use the auto-managed Java"
          onChange={(e) => setJavaPath(e.target.value)}
        />
      </div>
      <div className="row">
        <button className="primary" onClick={() => void save()}>
          Save changes
        </button>
      </div>
    </div>
  )
}

function BannerArt({ instance }: { instance: Instance }): React.JSX.Element {
  const { image, gradient } = useInstanceCover(instance)
  return (
    <div className="ibanner-bg" style={{ background: gradient }}>
      {image && <img src={image} alt="" />}
    </div>
  )
}

function BannerTile({ instance }: { instance: Instance }): React.JSX.Element {
  const { image, gradient } = useInstanceCover(instance)
  return (
    <div className="ibanner-tile" style={{ background: gradient }}>
      {image ? <img src={image} alt="" /> : instance.name.charAt(0).toUpperCase()}
    </div>
  )
}

export default function InstancePage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const { instances, runStates, progress, lastGameEvents, launch, kill, refreshInstances, cloudUser, cloudUpdates, refreshCloud } = useAppState()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('mods')
  const [packLink, setPackLink] = useState<PackLink | null>(null)
  const [showPublish, setShowPublish] = useState(false)
  const [showCoverPicker, setShowCoverPicker] = useState(false)
  const [crashHint, setCrashHint] = useState<CrashHint | null>(null)

  useEffect(() => {
    if (!id) return
    window.elauncher.packs.getPackLink(id).then(setPackLink).catch(console.error)
  }, [id])

  // When an instance crashes, read the tail of its logs to explain why in plain language.
  useEffect(() => {
    if (!id) return
    const ev = lastGameEvents[id]
    if (ev?.crashed && (runStates[id] ?? 'idle') === 'idle') {
      window.elauncher.game
        .getLogs(id)
        .then((lines) => setCrashHint(diagnoseCrash(lines, ev.error)))
        .catch(() => setCrashHint(null))
    } else {
      setCrashHint(null)
    }
  }, [id, lastGameEvents, runStates])

  const instance = instances.find((i) => i.id === id)
  if (!instance) {
    return (
      <div className="empty-state">
        <h2>Instance not found</h2>
        <button className="ghost" onClick={() => navigate('/instances')}>
          Back to instances
        </button>
      </div>
    )
  }

  const state = runStates[instance.id] ?? 'idle'
  const prog = progress[instance.id]
  const lastEvent = lastGameEvents[instance.id]

  const onPlay = async (): Promise<void> => {
    const error = await launch(instance.id)
    if (error) toast.error(error)
  }

  const onExport = async (): Promise<void> => {
    const result = await window.elauncher.packs.exportInstance(instance.id)
    if (result.ok) toast.success('Modpack exported')
    else if (result.error !== 'cancelled') toast.error(result.error ?? 'Export failed')
  }

  const onUpdatePack = async (): Promise<void> => {
    const result = await window.elauncher.packs.updatePack(instance.id)
    if (result.ok) {
      await refreshInstances()
      await refreshCloud()
      const link = await window.elauncher.packs.getPackLink(instance.id)
      setPackLink(link)
      if (result.upToDate) toast.success(`Already on the latest version (${result.version})`)
      else toast.success(`Modpack updated${result.version ? ` to ${result.version}` : ''}`)
    } else if (result.error !== 'cancelled') {
      toast.error(result.error ?? 'Update failed')
    }
  }

  const onDuplicate = async (): Promise<void> => {
    const copy = await window.elauncher.instances.duplicate(instance.id)
    await refreshInstances()
    navigate(`/instances/${copy.id}`)
  }

  const onDelete = async (): Promise<void> => {
    if (!confirm(`Delete "${instance.name}" and all its files (worlds, mods, configs)? This cannot be undone.`)) return
    await window.elauncher.instances.remove(instance.id)
    await refreshInstances()
    toast.success(`Deleted "${instance.name}"`)
    navigate('/instances')
  }

  return (
    <div>
      <div className="ibanner">
        <BannerArt instance={instance} />
        <div className="ibanner-content">
          <BannerTile instance={instance} />
          <div style={{ flex: 1, minWidth: 260 }}>
            <h1 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.025em' }}>{instance.name}</h1>
            <div className="row" style={{ marginTop: 8, flexWrap: 'wrap' }}>
              <span className={`chip loader-${instance.loader}`}>{instance.loader}</span>
              <span className="chip on-banner">{instance.minecraftVersion}</span>
              {instance.loaderVersion && <span className="chip on-banner">{instance.loaderVersion}</span>}
              {packLink && (
                <span className="chip on-banner" title={packLink.url ?? 'Imported from a local file'}>
                  <IconLink size={11} /> {packLink.name} {packLink.versionId}
                </span>
              )}
            </div>
            <div className="ibanner-stats">
              <span className="stat-chip">
                <IconClock size={13} /> <b>{formatPlaytime(instance.totalPlayMs)}</b> played
              </span>
              <span className="stat-chip">Last played {timeAgo(instance.lastPlayedAt)}</span>
            </div>
          </div>
          <div className="row">
            <button className="ghost" onClick={() => void window.elauncher.instances.openFolder(instance.id)}>
              <IconFolder size={15} /> Folder
            </button>
            {packLink && (
              <button
                className={cloudUpdates[instance.id] ? 'primary' : 'ghost'}
                title="Re-download the modpack and sync mods & configs. Worlds and mods you added yourself are kept."
                disabled={state !== 'idle'}
                onClick={() => void onUpdatePack()}
              >
                <IconDownload size={15} />{' '}
                {cloudUpdates[instance.id] ? `Update to ${cloudUpdates[instance.id].version}` : 'Update pack'}
              </button>
            )}
            {state === 'running' ? (
              <button className="danger" onClick={() => void kill(instance.id)}>
                <IconStop size={14} /> Stop
              </button>
            ) : (
              <button
                className="play"
                style={{ padding: '10px 24px', fontSize: 14.5 }}
                disabled={state !== 'idle'}
                onClick={() => void onPlay()}
              >
                <IconPlay size={14} /> {state === 'installing' ? 'Installing…' : 'Play'}
              </button>
            )}
            <Menu>
              <button onClick={() => setShowCoverPicker(true)}>
                <IconImage size={15} /> Change cover
              </button>
              <button onClick={() => void onDuplicate()}>
                <IconCopy size={15} /> Duplicate
              </button>
              <button onClick={() => void onExport()}>
                <IconExport size={15} /> Export modpack
              </button>
              {cloudUser?.isAdmin && (
                <button onClick={() => setShowPublish(true)}>
                  <IconCloud size={15} /> Publish to cloud
                </button>
              )}
              <hr />
              <button className="danger-item" onClick={() => void onDelete()}>
                <IconTrash size={15} /> Delete instance
              </button>
            </Menu>
          </div>
        </div>
      </div>

      {lastEvent?.crashed && state === 'idle' && (
        <div className="error-banner">
          <div style={{ flex: 1, minWidth: 0 }}>
            {crashHint ? (
              <>
                <strong>{crashHint.title}</strong>
                <div style={{ marginTop: 2 }}>{crashHint.detail}</div>
              </>
            ) : (
              <span>
                The game crashed{lastEvent.exitCode != null ? ` (exit code ${lastEvent.exitCode})` : ''}
                {lastEvent.error ? `: ${lastEvent.error}` : ''}. Check the Logs tab for details.
              </span>
            )}
          </div>
          <div className="row" style={{ flexShrink: 0 }}>
            {crashHint?.perfAction && (
              <button className="ghost small" onClick={() => setTab('performance')}>
                Performance
              </button>
            )}
            <button className="ghost small" onClick={() => setTab('logs')}>
              View logs
            </button>
          </div>
        </div>
      )}
      {state === 'installing' && prog && (
        <div className="card" style={{ marginBottom: 20, padding: 16 }}>
          <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span>{prog.phase}</span>
            {prog.progress >= 0 && <span>{Math.round(prog.progress * 100)}%</span>}
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill${prog.progress < 0 ? ' indeterminate' : ''}`}
              style={{ width: prog.progress >= 0 ? `${Math.round(prog.progress * 100)}%` : undefined }}
            />
          </div>
        </div>
      )}

      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'mods' && <InstalledModsTab instance={instance} />}
      {tab === 'performance' && <PerformanceTab instance={instance} onOpenTab={setTab} />}
      {tab === 'shaders' && <ContentTab key={`shader-${instance.id}`} instance={instance} kind="shader" />}
      {tab === 'resourcepacks' && (
        <ContentTab key={`resourcepack-${instance.id}`} instance={instance} kind="resourcepack" />
      )}
      {tab === 'worlds' && <WorldsTab instanceId={instance.id} />}
      {tab === 'servers' && <ServersTab instanceId={instance.id} />}
      {tab === 'game' && <GameSettingsTab instanceId={instance.id} />}
      {tab === 'logs' && <LogsTab instanceId={instance.id} />}
      {tab === 'settings' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <SettingsTab instance={instance} onSaved={() => void refreshInstances()} />
          <CopySettingsCard instance={instance} />
        </div>
      )}

      {showPublish && (
        <PublishPackModal
          instance={instance}
          packLink={packLink}
          onClose={() => setShowPublish(false)}
          onPublished={() => void refreshCloud()}
        />
      )}
      {showCoverPicker && (
        <CoverPickerModal
          instance={instance}
          onClose={() => setShowCoverPicker(false)}
          onChanged={() => {
            setShowCoverPicker(false)
            void refreshInstances()
          }}
        />
      )}
    </div>
  )
}
