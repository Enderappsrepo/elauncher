import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  CloudPack,
  LocalServer,
  LocalServerState,
  MinecraftVersionInfo,
  ModLoader,
  ModSearchHit,
  ServerGame,
  ServerKind,
  ServerMod,
  ServerSource,
  ServerTaskEvent
} from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { tileGradient, timeAgo } from '../fmt'
import {
  IconAlert,
  IconBox,
  IconCheck,
  IconClock,
  IconCopy,
  IconDownload,
  IconEdit,
  IconExport,
  IconFolder,
  IconGauge,
  IconGlobe,
  IconPlay,
  IconPlus,
  IconSearch,
  IconServer,
  IconShield,
  IconSliders,
  IconStop,
  IconTrash,
  IconUsers,
  IconWifi,
  IconX,
  IconZap
} from '../icons'

import Select from '../components/Select'
import AutomationCard from '../components/server/AutomationCard'
import PalworldSettingsTab from '../components/server/PalworldSettingsTab'
import PalworldPlayersTab from '../components/server/PalworldPlayersTab'
import FilesTab from '../components/server/FilesTab'
import PlayersTab from '../components/server/PlayersTab'
import AccessTab from '../components/server/AccessTab'
import RemoteServers from '../components/server/RemoteServers'
import HostReadiness from '../components/server/HostReadiness'

const MODDABLE_KINDS: ReadonlySet<ServerKind> = new Set(['fabric', 'neoforge', 'forge'])

interface Status {
  state: LocalServerState
  players: string[]
  tunnelAddress: string | null
  memoryMB?: number | null
  cpuPercent?: number | null
  startedAt?: number | null
  version?: string | null
  error?: string
}

const IDLE: Status = { state: 'stopped', players: [], tunnelAddress: null }

function fmtUptime(ms: number): string {
  const m = Math.floor(ms / 60_000)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  return d > 0 ? `${d}d ${h % 24}h` : h > 0 ? `${h}h ${m % 60}m` : `${Math.max(0, m)}m`
}

const STATE_LABEL: Record<LocalServerState, string> = {
  stopped: 'Stopped',
  starting: 'Starting…',
  running: 'Online',
  stopping: 'Stopping…'
}

function StateChip({ state }: { state: LocalServerState }): React.JSX.Element {
  if (state === 'running')
    return (
      <span className="chip running">
        <span className="dot pulse" /> Online
      </span>
    )
  return <span className="chip on-banner">{STATE_LABEL[state]}</span>
}

type CreateMode = 'fresh' | 'pack' | 'instance'

const KIND_OPTIONS: { value: ServerKind; label: string }[] = [
  { value: 'paper', label: 'Paper — best performance, plugins' },
  { value: 'vanilla', label: 'Vanilla — the official server' },
  { value: 'fabric', label: 'Fabric — for Fabric mods' },
  { value: 'neoforge', label: 'NeoForge — for NeoForge mods' },
  { value: 'forge', label: 'Forge — for Forge mods' }
]

/** Create-server dialog: fresh pick, from a modpack, or mirroring an instance. */
function CreateServerModal({
  onClose,
  onCreated
}: {
  onClose: () => void
  onCreated: (server: LocalServer) => void
}): React.JSX.Element {
  const { instances, cloudUser } = useAppState()
  const toast = useToast()
  const [game, setGame] = useState<ServerGame>('minecraft')
  const [palPassword, setPalPassword] = useState('')
  const [palMaxPlayers, setPalMaxPlayers] = useState(16)
  const [palCommunity, setPalCommunity] = useState(false)
  const [mode, setModeRaw] = useState<CreateMode>('fresh')
  const [versions, setVersions] = useState<MinecraftVersionInfo[]>([])
  const [name, setName] = useState('My Server')
  const [kind, setKind] = useState<ServerKind>('paper')
  const [version, setVersion] = useState('')
  const [memory, setMemory] = useState(2048)
  const [eula, setEula] = useState(false)
  const [busy, setBusy] = useState(false)
  const [task, setTask] = useState<ServerTaskEvent | null>(null)
  const [packSource, setPackSource] = useState<'browse' | 'file' | 'cloud'>('browse')
  const [cloudPacks, setCloudPacks] = useState<CloudPack[]>([])
  const [cloudPackId, setCloudPackId] = useState('')
  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? '')
  const [browseQuery, setBrowseQuery] = useState('')
  const [browseSource, setBrowseSource] = useState<'modrinth' | 'curseforge'>('modrinth')
  const [browseHits, setBrowseHits] = useState<ModSearchHit[]>([])
  const [browseSel, setBrowseSel] = useState<ModSearchHit | null>(null)
  const [browsing, setBrowsing] = useState(false)

  const setMode = (m: CreateMode): void => {
    setModeRaw(m)
    // modded servers want more headroom; pack/instance names default to the pack's
    setMemory(m === 'fresh' ? 2048 : 4096)
    setName((n) => (m !== 'fresh' && n === 'My Server' ? '' : n))
  }

  useEffect(() => {
    window.elauncher.versions
      .minecraft()
      .then((list) => {
        const releases = list.filter((v) => v.type === 'release')
        setVersions(releases)
        if (releases[0]) setVersion(releases[0].id)
      })
      .catch(console.error)
  }, [])

  useEffect(() => window.elauncher.server.onTask((e) => setTask(e.done ? null : e)), [])

  useEffect(() => {
    if (!cloudUser) return
    window.elauncher.cloud
      .listPacks()
      .then((packs) => {
        setCloudPacks(packs)
        if (packs[0]) setCloudPackId(packs[0].id)
      })
      .catch(() => {})
  }, [cloudUser])

  // modpack search (popular packs when the query is empty)
  useEffect(() => {
    if (mode !== 'pack' || packSource !== 'browse') return
    setBrowsing(true)
    const t = setTimeout(() => {
      window.elauncher.mods
        .search({ query: browseQuery, source: browseSource, projectType: 'modpack', limit: 8 })
        .then((r) => setBrowseHits(r.hits))
        .catch(() => setBrowseHits([]))
        .finally(() => setBrowsing(false))
    }, 300)
    return () => clearTimeout(t)
  }, [browseQuery, browseSource, mode, packSource])

  const source: ServerSource | null =
    game === 'palworld'
      ? { type: 'palworld', serverPassword: palPassword || undefined, maxPlayers: palMaxPlayers, communityServer: palCommunity }
      : mode === 'fresh'
        ? version
          ? { type: 'fresh', kind, minecraftVersion: version }
          : null
        : mode === 'pack'
          ? packSource === 'browse'
            ? browseSel
              ? browseSel.source === 'curseforge'
                ? { type: 'curseforgePack', projectId: browseSel.projectId }
                : { type: 'modrinthPack', projectId: browseSel.projectId }
              : null
            : packSource === 'cloud'
              ? cloudPackId
                ? { type: 'cloudPack', packId: cloudPackId }
                : null
              : { type: 'mrpack' }
          : instanceId
            ? { type: 'instance', instanceId }
            : null

  const create = async (): Promise<void> => {
    if (!source) return
    setBusy(true)
    try {
      const res = await window.elauncher.server.create({ name, memoryMax: memory, acceptEula: eula, source })
      if (res.ok && res.server) {
        toast.success(`Created "${res.server.name}" — press Start to bring it online`)
        onCreated(res.server)
      } else if (res.error !== 'cancelled') {
        toast.error(res.error ?? 'Could not create the server')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    // no backdrop-click dismissal: an accidental click must not abandon a long install
    <div className="modal-backdrop">
      <div className="modal" style={{ width: 490 }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h2>New server</h2>
          <button className="icon-btn" disabled={busy} onClick={onClose}>
            <IconX size={16} />
          </button>
        </div>

        <div className="field">
          <label>Game</label>
          <div className="segmented">
            <button
              className={game === 'minecraft' ? 'active' : ''}
              onClick={() => {
                setGame('minecraft')
                setName((n) => (n === 'My Palworld Server' ? 'My Server' : n))
              }}
            >
              Minecraft
            </button>
            <button
              className={game === 'palworld' ? 'active' : ''}
              onClick={() => {
                setGame('palworld')
                setName((n) => (n === 'My Server' ? 'My Palworld Server' : n))
              }}
            >
              Palworld
            </button>
          </div>
        </div>

        {game === 'minecraft' && (
          <div className="segmented">
            <button className={mode === 'fresh' ? 'active' : ''} onClick={() => setMode('fresh')}>
              Fresh
            </button>
            <button className={mode === 'pack' ? 'active' : ''} onClick={() => setMode('pack')}>
              From modpack
            </button>
            <button className={mode === 'instance' ? 'active' : ''} disabled={instances.length === 0} onClick={() => setMode('instance')}>
              From instance
            </button>
          </div>
        )}

        <div className="field">
          <label>Name</label>
          <input
            value={name}
            placeholder={mode === 'fresh' ? 'My Server' : "Defaults to the pack's name"}
            autoFocus
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        {game === 'palworld' && (
          <>
            <div className="props-grid">
              <div className="field">
                <label>Join password (optional)</label>
                <input
                  value={palPassword}
                  placeholder="Empty = anyone with the address"
                  onChange={(e) => setPalPassword(e.target.value)}
                />
              </div>
              <div className="field">
                <label>Max players</label>
                <input
                  type="number"
                  min={1}
                  max={32}
                  value={palMaxPlayers}
                  onChange={(e) => setPalMaxPlayers(Math.min(32, Math.max(1, Number(e.target.value) || 16)))}
                />
              </div>
            </div>
            <label className="checkbox-row">
              <input type="checkbox" checked={palCommunity} onChange={(e) => setPalCommunity(e.target.checked)} />
              <span>
                List in Palworld&apos;s community server browser{' '}
                <span className="faint small">— name and description become public; needs the port reachable</span>
              </span>
            </label>
            <div className="hint">
              The dedicated server is a free ~8 GB download from Steam (no Steam account needed) — the first install
              takes a while. Hosting works best with 16 GB of RAM.
            </div>
          </>
        )}

        {game === 'minecraft' && mode === 'fresh' && (
          <>
            <div className="field">
              <label>Server type</label>
              <Select value={kind} onChange={(v) => setKind(v as ServerKind)} options={KIND_OPTIONS} />
              <div className="hint">
                Paper for plain multiplayer. Pick Fabric/NeoForge/Forge to run server-side mods (drop them in the mods
                folder, or create from a modpack instead).
              </div>
            </div>
            <div className="field">
              <label>Minecraft version</label>
              <Select
                value={version}
                onChange={setVersion}
                options={versions.slice(0, 40).map((v) => ({ value: v.id, label: v.id }))}
              />
            </div>
          </>
        )}

        {game === 'minecraft' && mode === 'pack' && (
          <div className="field">
            <label>Modpack</label>
            <div className="segmented" style={{ marginBottom: 8 }}>
              <button className={packSource === 'browse' ? 'active' : ''} onClick={() => setPackSource('browse')}>
                Browse Modrinth
              </button>
              {cloudPacks.length > 0 && (
                <button className={packSource === 'cloud' ? 'active' : ''} onClick={() => setPackSource('cloud')}>
                  Cloud library
                </button>
              )}
              <button className={packSource === 'file' ? 'active' : ''} onClick={() => setPackSource('file')}>
                .mrpack file
              </button>
            </div>
            {packSource === 'browse' && (
              <>
                <div className="segmented" style={{ marginBottom: 8, maxWidth: 300 }}>
                  <button
                    className={browseSource === 'modrinth' ? 'active' : ''}
                    onClick={() => {
                      setBrowseSource('modrinth')
                      setBrowseSel(null)
                    }}
                  >
                    Modrinth
                  </button>
                  <button
                    className={browseSource === 'curseforge' ? 'active' : ''}
                    onClick={() => {
                      setBrowseSource('curseforge')
                      setBrowseSel(null)
                    }}
                  >
                    CurseForge
                  </button>
                </div>
                <div className="search-wrap" style={{ marginBottom: 8 }}>
                  <IconSearch size={14} />
                  <input
                    placeholder="Search modpacks… (empty shows the most popular)"
                    value={browseQuery}
                    onChange={(e) => setBrowseQuery(e.target.value)}
                  />
                </div>
                {browseSource === 'curseforge' && (
                  <div className="hint" style={{ marginBottom: 8 }}>
                    CurseForge needs your API key from Settings. Packs install their mods server-side; a client-only
                    mod may need removing in Files if the console complains.
                  </div>
                )}
                <div className="pick-list">
                  {browsing && browseHits.length === 0 ? (
                    <div className="skeleton" style={{ height: 90 }} />
                  ) : (
                    browseHits.map((hit) => (
                      <button
                        key={hit.projectId}
                        className={`pick-row${browseSel?.projectId === hit.projectId ? ' active' : ''}`}
                        onClick={() => setBrowseSel(hit)}
                      >
                        {hit.iconUrl ? (
                          <img src={hit.iconUrl} alt="" loading="lazy" />
                        ) : (
                          <span className="pick-icon">
                            <IconBox size={14} />
                          </span>
                        )}
                        <span className="pick-name">{hit.title}</span>
                        <span className="pick-meta">{Intl.NumberFormat('en', { notation: 'compact' }).format(hit.downloads)} dl</span>
                      </button>
                    ))
                  )}
                  {!browsing && browseHits.length === 0 && <div className="hint">No modpacks found for that search.</div>}
                </div>
              </>
            )}
            {packSource === 'cloud' && cloudPacks.length > 0 && (
              <Select
                value={cloudPackId}
                onChange={setCloudPackId}
                options={cloudPacks.map((p) => ({ value: p.id, label: `${p.name} (${p.minecraftVersion} ${p.loader})` }))}
              />
            )}
            {packSource === 'file' && (
              <div className="hint">
                You'll pick the .mrpack file when you press Create. The loader, version and server-side mods come from
                the pack (client-only mods are skipped automatically).
              </div>
            )}
          </div>
        )}

        {game === 'minecraft' && mode === 'instance' && (
          <div className="field">
            <label>Instance to mirror</label>
            <Select
              value={instanceId}
              onChange={setInstanceId}
              options={instances.map((i) => ({ value: i.id, label: `${i.name} (${i.minecraftVersion} ${i.loader})` }))}
            />
            <div className="hint">
              Copies the instance's mods and configs onto a matching server — client-only mods (Sodium & co.) are
              skipped automatically. Worlds are not copied; the server generates its own.
            </div>
          </div>
        )}

        {game === 'minecraft' && (
          <div className="field">
            <label>Memory</label>
            <div className="segmented">
              {[2048, 4096, 6144, 8192].map((m) => (
                <button key={m} className={memory === m ? 'active' : ''} onClick={() => setMemory(m)}>
                  {m / 1024} GB
                </button>
              ))}
            </div>
          </div>
        )}
        <label className="checkbox-row">
          <input type="checkbox" checked={eula} onChange={(e) => setEula(e.target.checked)} />
          <span>
            {game === 'palworld' ? (
              <>
                I accept Pocketpair&apos;s{' '}
                <a href="https://docs.palworldgame.com/" target="_blank" rel="noreferrer">
                  dedicated server terms
                </a>
              </>
            ) : (
              <>
                I accept the{' '}
                <a href="https://www.minecraft.net/eula" target="_blank" rel="noreferrer">
                  Minecraft EULA
                </a>
              </>
            )}
          </span>
        </label>
        {task && (
          <div>
            <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
              <span>{task.phase}</span>
              {task.progress >= 0 && <span>{Math.round(task.progress * 100)}%</span>}
            </div>
            <div className="progress-track">
              <div
                className={`progress-fill${task.progress < 0 ? ' indeterminate' : ''}`}
                style={{ width: task.progress >= 0 ? `${Math.round(task.progress * 100)}%` : undefined }}
              />
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button className="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={busy || !eula || !source} onClick={() => void create()}>
            <IconPlus size={14} /> {busy ? 'Creating…' : 'Create server'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Live console: streamed log + command input. */
function Console({
  serverId,
  running,
  palworld
}: {
  serverId: string
  running: boolean
  palworld?: boolean
}): React.JSX.Element {
  const toast = useToast()
  const [lines, setLines] = useState<string[]>([])
  const [cmd, setCmd] = useState('')
  const viewRef = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useEffect(() => {
    setLines([])
    window.elauncher.server.getLogs(serverId).then(setLines).catch(console.error)
    return window.elauncher.server.onLog((e) => {
      if (e.serverId === serverId) setLines((prev) => [...prev.slice(-999), e.line])
    })
  }, [serverId])

  useEffect(() => {
    if (stick.current) viewRef.current?.scrollTo({ top: viewRef.current.scrollHeight })
  }, [lines])

  const send = async (): Promise<void> => {
    const command = cmd.trim()
    if (!command) return
    setCmd('')
    const res = await window.elauncher.server.command(serverId, command)
    if (!res.ok) toast.error(res.error ?? 'Command failed')
  }

  return (
    <div className="terminal">
      <div className="terminal-bar">
        <span className="term-dot red" />
        <span className="term-dot yellow" />
        <span className="term-dot green" />
        <span className="terminal-title">Console</span>
        <span className={`terminal-live${running ? ' on' : ''}`}>
          <span className="dot" /> {running ? 'live' : 'offline'}
        </span>
      </div>
      <div
        className="log-view terminal-body"
        ref={viewRef}
        onScroll={() => {
          const el = viewRef.current
          if (el) stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40
        }}
      >
        {lines.length === 0 ? (
          <span className="faint">No output yet. Start the server to see its console.</span>
        ) : (
          lines.map((l, i) => (
            <div key={i} className="log-line">
              {l}
            </div>
          ))
        )}
      </div>
      <div className="terminal-prompt">
        <span className="prompt-glyph">›</span>
        <input
          placeholder={
            running
              ? palworld
                ? 'say hi · players · save · kick <steam id>…'
                : 'whitelist add Steve · op Steve · say hi…'
              : 'Start the server to send commands'
          }
          value={cmd}
          disabled={!running}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void send()
          }}
        />
        <button className="ghost small" disabled={!running || !cmd.trim()} onClick={() => void send()}>
          Send
        </button>
      </div>
    </div>
  )
}

const CONTENT_PAGE_SIZE = 8

/**
 * Full browser for server content — mods on Fabric/NeoForge/Forge, plugins on
 * Paper — mirroring the main Browse page: popular results when the query is
 * empty, rich rows, pagination, and the installed list underneath.
 */
function ServerModsCard({ server, running }: { server: LocalServer; running: boolean }): React.JSX.Element {
  const toast = useToast()
  const isPaper = server.kind === 'paper'
  const noun = isPaper ? 'plugin' : 'mod'
  const supported = isPaper || MODDABLE_KINDS.has(server.kind)

  const [installed, setInstalled] = useState<ServerMod[] | null>(null)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ModSearchHit[] | null>(null)
  const [totalHits, setTotalHits] = useState(0)
  const [offset, setOffset] = useState(0)
  const [searching, setSearching] = useState(false)
  const [installing, setInstalling] = useState<string | null>(null)

  const refresh = useCallback(() => {
    window.elauncher.server.listMods(server.id).then(setInstalled).catch(console.error)
  }, [server.id])

  useEffect(() => refresh(), [refresh])

  const search = useCallback(
    (newOffset: number) => {
      if (!supported) return
      setSearching(true)
      window.elauncher.mods
        .search({
          query,
          // plugins usually span many versions; only mods get the strict version filter
          mcVersion: isPaper ? undefined : server.minecraftVersion,
          loader: isPaper ? undefined : (server.kind as ModLoader),
          source: 'modrinth',
          projectType: isPaper ? 'plugin' : 'mod',
          offset: newOffset,
          limit: CONTENT_PAGE_SIZE
        })
        .then((r) => {
          setHits(r.hits)
          setTotalHits(r.totalHits)
          setOffset(newOffset)
        })
        .catch(() => setHits([]))
        .finally(() => setSearching(false))
    },
    [query, supported, isPaper, server.kind, server.minecraftVersion]
  )

  useEffect(() => {
    if (!supported) return
    const t = setTimeout(() => search(0), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, server.id])

  const install = async (hit: ModSearchHit): Promise<void> => {
    setInstalling(hit.projectId)
    try {
      const res = await window.elauncher.server.installMod(server.id, hit.projectId)
      if (res.ok) toast.success(`Installed ${hit.title}${running ? ' — restart the server to load it' : ''}`)
      else toast.error(res.error ?? 'Install failed')
      refresh()
    } finally {
      setInstalling(null)
    }
  }

  const remove = async (mod: ServerMod): Promise<void> => {
    const next = await window.elauncher.server.removeMod(server.id, mod.fileName)
    setInstalled(next)
    toast.success(`Removed ${mod.title ?? mod.fileName}${running ? ' — restart the server to apply' : ''}`)
  }

  if (!supported) {
    return (
      <div className="card settings-section">
        <div className="hint">
          Vanilla servers have no mod loader. Create a <b>Paper</b> server for plugins, or a Fabric/NeoForge/Forge
          server for mods.
        </div>
      </div>
    )
  }

  const installedIds = new Set((installed ?? []).map((m) => m.projectId).filter(Boolean))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between', flexWrap: 'wrap' }}>
        <div className="muted small">
          {isPaper
            ? `Paper plugins from Modrinth — installed into the plugins folder`
            : `Server-side mods for ${server.minecraftVersion} ${server.kind}`}
        </div>
        {installed && installed.length > 0 && (
          <span className="small faint">
            {installed.length} {noun}
            {installed.length === 1 ? '' : 's'} installed
          </span>
        )}
      </div>

      <div className="search-wrap">
        <IconSearch size={15} />
        <input
          placeholder={`Search ${noun}s… (empty shows the most popular)`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {hits === null || (searching && hits.length === 0) ? (
        <div className="mod-list">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="skeleton" style={{ height: 76 }} />
          ))}
        </div>
      ) : (
        <div className="mod-list">
          {hits.map((hit) => {
            const done = installedIds.has(hit.projectId)
            return (
              <div className="mod-row" key={hit.projectId}>
                {hit.iconUrl ? (
                  <img className="mod-icon" src={hit.iconUrl} alt="" loading="lazy" />
                ) : (
                  <div className="mod-icon-placeholder">
                    <IconBox size={20} />
                  </div>
                )}
                <div className="info">
                  <h4>
                    {hit.title} <span className="by">by {hit.author}</span>
                  </h4>
                  <p>{hit.description}</p>
                  <div className="meta">
                    <span>
                      <IconDownload size={11} />{' '}
                      {Intl.NumberFormat('en', { notation: 'compact' }).format(hit.downloads)} downloads
                    </span>
                  </div>
                </div>
                <button
                  className={done ? 'ghost' : 'primary'}
                  style={{ minWidth: 110 }}
                  disabled={done || installing === hit.projectId}
                  onClick={() => void install(hit)}
                >
                  {done ? (
                    <>
                      <IconCheck size={14} /> Installed
                    </>
                  ) : installing === hit.projectId ? (
                    'Installing…'
                  ) : (
                    <>
                      <IconDownload size={14} /> Install
                    </>
                  )}
                </button>
              </div>
            )
          })}
          {hits.length === 0 && <div className="hint">No compatible {noun}s found for that search.</div>}
        </div>
      )}

      {totalHits > CONTENT_PAGE_SIZE && hits !== null && (
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="ghost small" disabled={offset === 0 || searching} onClick={() => search(offset - CONTENT_PAGE_SIZE)}>
            Previous
          </button>
          <span className="muted small">
            {offset + 1}–{Math.min(offset + CONTENT_PAGE_SIZE, totalHits)} of{' '}
            {Intl.NumberFormat('en', { notation: 'compact' }).format(totalHits)}
          </span>
          <button
            className="ghost small"
            disabled={offset + CONTENT_PAGE_SIZE >= totalHits || searching}
            onClick={() => search(offset + CONTENT_PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}

      {installed && installed.length > 0 && (
        <div className="card settings-section">
          <div className="section-title">
            <span className="row" style={{ gap: 9 }}>
              <IconBox size={15} /> Installed {noun}s
            </span>
          </div>
          <div className="pick-list" style={{ maxHeight: 'none' }}>
            {installed.map((mod) => (
              <div key={mod.fileName} className="pick-row static">
                {mod.iconUrl ? (
                  <img src={mod.iconUrl} alt="" loading="lazy" />
                ) : (
                  <span className="pick-icon">
                    <IconBox size={14} />
                  </span>
                )}
                <span className="pick-name">{mod.title ?? mod.fileName}</span>
                {mod.versionNumber && <span className="pick-meta">{mod.versionNumber}</span>}
                <button className="icon-btn" title="Remove" onClick={() => void remove(mod)}>
                  <IconTrash size={14} />
                </button>
              </div>
            ))}
          </div>
          {running && <div className="hint">Changes load on the next server restart.</div>}
        </div>
      )}
    </div>
  )
}

/** Common server.properties in friendly controls; anything else stays untouched in the file. */
function PropertiesCard({ server }: { server: LocalServer }): React.JSX.Element {
  const toast = useToast()
  const [props, setProps] = useState<Record<string, string> | null>(null)
  const [dirty, setDirty] = useState<Record<string, string>>({})
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    setDirty({})
    window.elauncher.server.getProperties(server.id).then(setProps).catch(console.error)
  }, [server.id])

  const merged = useMemo(() => ({ ...(props ?? {}), ...dirty }), [props, dirty])
  const get = (key: string, fallback: string): string => merged[key] ?? fallback
  const set = (key: string, value: string): void => setDirty((d) => ({ ...d, [key]: value }))

  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const next = await window.elauncher.server.setProperties(server.id, dirty)
      setProps(next)
      setDirty({})
      toast.success('Saved — applies next time the server starts')
    } finally {
      setSaving(false)
    }
  }

  if (!props) return <div className="skeleton" style={{ height: 180 }} />

  return (
    <div className="card settings-section">
      <div className="section-title">
        <span className="row" style={{ gap: 9 }}>
          <IconServer size={15} /> Server settings
        </span>
      </div>
      <div className="field">
        <label>MOTD (shown in the multiplayer list)</label>
        <input value={get('motd', server.name)} onChange={(e) => set('motd', e.target.value)} />
      </div>
      <div className="props-grid">
        <div className="field">
          <label>Max players</label>
          <input
            type="number"
            min={1}
            max={100}
            value={Number(get('max-players', '10'))}
            onChange={(e) => set('max-players', String(Math.max(1, Number(e.target.value) || 10)))}
          />
        </div>
        <div className="field">
          <label>Game mode</label>
          <Select
            value={get('gamemode', 'survival')}
            onChange={(v) => set('gamemode', v)}
            options={['survival', 'creative', 'adventure'].map((g) => ({ value: g, label: g }))}
          />
        </div>
        <div className="field">
          <label>Difficulty</label>
          <Select
            value={get('difficulty', 'normal')}
            onChange={(v) => set('difficulty', v)}
            options={['peaceful', 'easy', 'normal', 'hard'].map((d) => ({ value: d, label: d }))}
          />
        </div>
        <div className="field">
          <label>View distance</label>
          <input
            type="number"
            min={4}
            max={20}
            value={Number(get('view-distance', '10'))}
            onChange={(e) => set('view-distance', String(Math.min(20, Math.max(4, Number(e.target.value) || 10))))}
          />
        </div>
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={get('pvp', 'true') === 'true'} onChange={(e) => set('pvp', String(e.target.checked))} />
        <span>PvP enabled</span>
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={get('white-list', 'false') === 'true'}
          onChange={(e) => set('white-list', String(e.target.checked))}
        />
        <span>
          Whitelist only <span className="faint small">— add friends from the console: whitelist add TheirName</span>
        </span>
      </label>
      <div className="row">
        <button className="primary" disabled={saving || Object.keys(dirty).length === 0} onClick={() => void save()}>
          Save settings
        </button>
        {Object.keys(dirty).length > 0 && <span className="small faint">restart to apply</span>}
      </div>
    </div>
  )
}

/** Tunnel + publish-to-friends controls for a running server. */
function ShareCard({ server, status }: { server: LocalServer; status: Status }): React.JSX.Element {
  const { cloudUser } = useAppState()
  const toast = useToast()
  const [tunneling, setTunneling] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [published, setPublished] = useState(false)

  const running = status.state === 'running'
  const palworld = server.game === 'palworld'
  const [share, setShare] = useState<{ publicIp: string | null; tailscaleIp: string | null } | null>(null)

  // alternative share paths for UDP games: manual port-forward (WAN IP) and Tailscale
  useEffect(() => {
    if (!palworld || !running) return
    let alive = true
    window.elauncher.server
      .shareInfo()
      .then((s) => {
        if (alive) setShare(s)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [palworld, running])

  const startTunnel = async (): Promise<void> => {
    setTunneling(true)
    try {
      const res = await window.elauncher.server.tunnelStart(server.port)
      if (res.ok && res.address) {
        if (res.warning) toast.error(res.warning)
        else if (palworld) toast.success('Port opened — share the address with friends')
        else toast.success('Public address is live — share it or publish below')
      } else toast.error(res.error ?? (palworld ? 'Could not open the port on your router' : 'Could not get a public address'))
    } finally {
      setTunneling(false)
    }
  }

  const publish = async (): Promise<void> => {
    if (!status.tunnelAddress) return
    setPublishing(true)
    try {
      const res = await window.elauncher.cloud.sessions.publish({
        name: server.name,
        address: status.tunnelAddress,
        minecraftVersion: server.minecraftVersion,
        // paper plays like vanilla for joiners; modded servers tell friends which loader they need
        loader: server.kind === 'paper' ? 'vanilla' : server.kind
      })
      if (res.ok) {
        setPublished(true)
        toast.success('Published — friends see it under Play Together and can join in one click')
      } else toast.error(res.error ?? 'Could not publish')
    } finally {
      setPublishing(false)
    }
  }

  const unpublish = async (): Promise<void> => {
    await window.elauncher.cloud.sessions.end()
    setPublished(false)
    toast.success('Session unpublished')
  }

  const copy = (value: string): void => {
    void navigator.clipboard.writeText(value)
    toast.success('Copied')
  }

  return (
    <div className="card settings-section">
      <div className="section-title">
        <span className="row" style={{ gap: 9 }}>
          <IconWifi size={15} /> Invite players
        </span>
      </div>
      {!running && <div className="hint">Start the server, then share it from here.</div>}
      {running && (
        <>
          <div className="field">
            <label>Same network (LAN)</label>
            <div className="join-addr">
              <IconServer size={14} /> localhost:{server.port}
              <button className="icon-btn" title="Copy" style={{ marginLeft: 'auto' }} onClick={() => copy(`localhost:${server.port}`)}>
                <IconCopy size={14} />
              </button>
            </div>
            <div className="hint">
              {palworld
                ? 'In Palworld: Join Multiplayer → Direct Connect. Friends on your Wi-Fi use your PC’s local IP instead of localhost.'
                : 'Friends on your Wi-Fi use your PC’s local IP instead of localhost.'}
            </div>
          </div>
          <div className="field">
            <label>{palworld ? 'Anywhere (opens the port on your router)' : 'Anywhere (public address)'}</label>
            {status.tunnelAddress ? (
              <div className="join-addr">
                <IconGlobe size={14} /> {status.tunnelAddress}
                <button className="icon-btn" title="Copy" style={{ marginLeft: 'auto' }} onClick={() => copy(status.tunnelAddress!)}>
                  <IconCopy size={14} />
                </button>
              </div>
            ) : (
              <button className="ghost" style={{ alignSelf: 'flex-start' }} disabled={tunneling} onClick={() => void startTunnel()}>
                <IconGlobe size={14} />{' '}
                {tunneling ? (palworld ? 'Opening…' : 'Starting…') : palworld ? 'Open port & get address' : 'Get public address'}
              </button>
            )}
            {!status.tunnelAddress && (
              <div className="hint">
                {palworld
                  ? `Uses UPnP — if your router has it disabled, forward UDP port ${server.port} to this PC manually.`
                  : 'Opens the port on your router (UPnP) for a direct address, or falls back to the free bore.pub relay.'}
              </div>
            )}
            {status.tunnelAddress && (
              <div className="row" style={{ marginTop: 8 }}>
                {palworld ? (
                  <span className="hint">Friends join via Join Multiplayer → Direct Connect in Palworld.</span>
                ) : cloudUser ? (
                  published ? (
                    <button className="ghost small" onClick={() => void unpublish()}>
                      Stop sharing with friends
                    </button>
                  ) : (
                    <button className="primary small" disabled={publishing} onClick={() => void publish()}>
                      <IconUsers size={13} /> {publishing ? 'Publishing…' : 'Publish to friends'}
                    </button>
                  )
                ) : (
                  <span className="hint">Sign in to your ELauncher account to publish this to the Play Together board.</span>
                )}
                <button className="ghost small" onClick={() => void window.elauncher.server.tunnelStop(server.port)}>
                  {palworld ? 'Close port' : 'Stop sharing'}
                </button>
              </div>
            )}
          </div>
          {palworld && !status.tunnelAddress && share?.publicIp && (
            <div className="field">
              <label>Manual port forward</label>
              <div className="join-addr">
                <IconGlobe size={14} /> {share.publicIp}:{server.port}
                <button
                  className="icon-btn"
                  title="Copy"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => copy(`${share.publicIp}:${server.port}`)}
                >
                  <IconCopy size={14} />
                </button>
              </div>
              <div className="hint">
                Your live public address — works once UDP {server.port} is forwarded to this PC on your router.
                {server.communityServer ? ' Community listing announces this address automatically.' : ''}
              </div>
            </div>
          )}
          {palworld && share?.tailscaleIp && (
            <div className="field">
              <label>Tailscale (no router setup)</label>
              <div className="join-addr">
                <IconWifi size={14} /> {share.tailscaleIp}:{server.port}
                <button
                  className="icon-btn"
                  title="Copy"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => copy(`${share.tailscaleIp}:${server.port}`)}
                >
                  <IconCopy size={14} />
                </button>
              </div>
              <div className="hint">For friends on your Tailscale network — they install Tailscale, join your tailnet, done.</div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

type ServerTab = 'overview' | 'mods' | 'files' | 'players' | 'settings' | 'access'

const SERVER_TABS: { id: ServerTab; label: string; icon: React.JSX.Element }[] = [
  { id: 'overview', label: 'Overview', icon: <IconServer size={14} /> },
  { id: 'mods', label: 'Mods', icon: <IconBox size={14} /> },
  { id: 'files', label: 'Files', icon: <IconFolder size={14} /> },
  { id: 'players', label: 'Players', icon: <IconUsers size={14} /> },
  { id: 'settings', label: 'Settings', icon: <IconSliders size={14} /> },
  { id: 'access', label: 'Access', icon: <IconShield size={14} /> }
]

/** Copyable address tile for the overview stat strip. */
function AddressTile({ address, isPublic }: { address: string; isPublic: boolean }): React.JSX.Element {
  const toast = useToast()
  return (
    <button
      className="stat-tile stat-tile-btn"
      title="Copy address"
      onClick={() => {
        void navigator.clipboard.writeText(address)
        toast.success('Address copied')
      }}
    >
      <div className="stat-icon" style={isPublic ? { background: 'var(--green-soft)', color: 'var(--green)' } : undefined}>
        <IconGlobe size={18} />
      </div>
      <div style={{ minWidth: 0 }}>
        <div className="stat-value stat-value-sm">{address}</div>
        <div className="stat-label">{isPublic ? 'Public address · copy' : 'Local address · copy'}</div>
      </div>
    </button>
  )
}

export default function ServerPage(): React.JSX.Element {
  const toast = useToast()
  const [servers, setServers] = useState<LocalServer[] | null>(null)
  const [statuses, setStatuses] = useState<Record<string, Status>>({})
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [showCreate, setShowCreate] = useState(false)
  const [tab, setTab] = useState<ServerTab>('overview')
  const [renameDraft, setRenameDraft] = useState<string | null>(null)

  useEffect(() => {
    setTab('overview')
    setRenameDraft(null)
  }, [selectedId])

  const refresh = useCallback(async () => {
    const [list, states] = await Promise.all([window.elauncher.server.list(), window.elauncher.server.getStates()])
    setServers(list)
    setStatuses(states)
    setSelectedId((sel) => sel ?? list[0]?.id ?? null)
  }, [])

  useEffect(() => {
    void refresh()
    return window.elauncher.server.onState((e) => {
      setStatuses((s) => ({
        ...s,
        [e.serverId]: {
          state: e.state,
          players: e.players,
          tunnelAddress: e.tunnelAddress ?? null,
          memoryMB: e.memoryMB ?? null,
          cpuPercent: e.cpuPercent ?? null,
          startedAt: e.startedAt ?? null,
          version: e.version ?? null,
          error: e.error
        }
      }))
      if (e.error) toast.error(e.error)
    })
  }, [refresh, toast])

  const selected = servers?.find((s) => s.id === selectedId) ?? null
  const selStatus = (selected && statuses[selected.id]) || IDLE
  const selRunning = selStatus.state === 'running' || selStatus.state === 'starting'

  const start = async (id: string): Promise<void> => {
    const res = await window.elauncher.server.start(id)
    if (!res.ok) toast.error(res.error ?? 'Could not start the server')
  }

  const exportPack = async (server: LocalServer): Promise<void> => {
    const res = await window.elauncher.server.exportPack(server.id)
    if (res.ok) {
      toast.success('Client modpack exported — share the .mrpack; players install it from Browse → Modpacks or Import')
    } else if (res.error !== 'cancelled') {
      toast.error(res.error ?? 'Export failed')
    }
  }

  const commitRename = async (server: LocalServer): Promise<void> => {
    const name = (renameDraft ?? '').trim()
    setRenameDraft(null)
    if (!name || name === server.name) return
    // palworld: the launcher/phone name and the in-game join-screen name can differ — ask
    const syncGameName =
      server.game === 'palworld'
        ? confirm('Also show the new name on the Palworld join screen and community listing?\n\nCancel renames it in the launcher and phone dashboard only.')
        : true
    const servers = await window.elauncher.server.updateSettings(server.id, name, server.memoryMax, syncGameName)
    setServers(servers)
    toast.success(syncGameName ? 'Renamed — the in-game name follows on the next start' : 'Renamed in the launcher only')
  }

  const forceStop = async (server: LocalServer): Promise<void> => {
    if (
      !confirm(
        `Force stop "${server.name}"?\n\nThis kills the server process immediately. Anything it had not written to disk since its last save is lost. Only do this if a normal stop is not finishing.`
      )
    )
      return
    await window.elauncher.server.forceStop(server.id)
    toast.success(`Force stopped "${server.name}"`)
  }

  const remove = async (server: LocalServer): Promise<void> => {
    if (!confirm(`Delete "${server.name}" and its world files? This cannot be undone.`)) return
    const res = await window.elauncher.server.remove(server.id)
    if (!res.ok) toast.error(res.error ?? 'Could not delete the server')
    else {
      toast.success(`Deleted "${server.name}"`)
      setServers(res.servers)
      setSelectedId(res.servers[0]?.id ?? null)
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Server</h1>
          <p className="muted small" style={{ marginTop: 2 }}>
            Your own Minecraft and Palworld servers, running on this PC — managed like a pro.
          </p>
        </div>
        <button className="primary" onClick={() => setShowCreate(true)}>
          <IconPlus size={15} /> New server
        </button>
      </div>

      {servers === null ? (
        <div className="skeleton" style={{ height: 260 }} />
      ) : servers.length === 0 ? (
        <div className="server-welcome">
          <div className="server-welcome-art" />
          <div className="server-welcome-body">
            <h2>Host your own Minecraft or Palworld server</h2>
            <p>
              A real dedicated server on this PC in about a minute — the launcher handles the downloads, Java, and
              getting friends connected.
            </p>
            <div className="welcome-grid">
              <div className="welcome-item">
                <span className="welcome-icon">
                  <IconZap size={16} />
                </span>
                <div>
                  <b>60-second setup</b>
                  <span>Pick a version, accept the EULA, press Start.</span>
                </div>
              </div>
              <div className="welcome-item">
                <span className="welcome-icon">
                  <IconGlobe size={16} />
                </span>
                <div>
                  <b>No port forwarding</b>
                  <span>One click makes a public join address.</span>
                </div>
              </div>
              <div className="welcome-item">
                <span className="welcome-icon">
                  <IconBox size={16} />
                </span>
                <div>
                  <b>Mods & modpacks</b>
                  <span>Paper, Fabric, NeoForge, Forge — or a whole pack.</span>
                </div>
              </div>
              <div className="welcome-item">
                <span className="welcome-icon">
                  <IconUsers size={16} />
                </span>
                <div>
                  <b>Manage together</b>
                  <span>Give friends console access from their launcher.</span>
                </div>
              </div>
            </div>
            <button className="primary" style={{ padding: '11px 24px' }} onClick={() => setShowCreate(true)}>
              <IconPlus size={15} /> Create your first server
            </button>
          </div>
        </div>
      ) : (
        <div className="server-layout">
          <div className="srail">
            {servers.map((s) => {
              const st = statuses[s.id] ?? IDLE
              return (
                <button
                  key={s.id}
                  className={`srail-item${selectedId === s.id ? ' active' : ''}`}
                  onClick={() => setSelectedId(s.id)}
                >
                  <span className="srail-tile" style={{ background: tileGradient(s.id) }}>
                    {s.name.charAt(0).toUpperCase()}
                    <span className={`srail-dot ${st.state}`} />
                  </span>
                  <span className="srail-info">
                    <span className="srail-name">{s.name}</span>
                    <span className="srail-meta">
                      {s.game === 'palworld' ? 'Palworld' : `${s.kind} · ${s.minecraftVersion}`}
                    </span>
                  </span>
                  {st.players.length > 0 && (
                    <span className="srail-players">
                      <IconUsers size={11} /> {st.players.length}
                    </span>
                  )}
                </button>
              )
            })}
            <button className="srail-new" onClick={() => setShowCreate(true)}>
              <IconPlus size={14} /> New server
            </button>
          </div>

          {selected && (
            <div className="server-detail">
              <div className="server-hero">
                <div className="server-hero-bg" style={{ background: tileGradient(selected.id) }} />
                <div className="server-hero-content">
                  <div className="server-hero-tile" style={{ background: tileGradient(selected.id) }}>
                    {selected.name.charAt(0).toUpperCase()}
                  </div>
                  <div className="server-hero-info">
                    <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
                      {renameDraft === null ? (
                        <h2>{selected.name}</h2>
                      ) : (
                        <input
                          autoFocus
                          value={renameDraft}
                          onChange={(e) => setRenameDraft(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void commitRename(selected)
                            if (e.key === 'Escape') setRenameDraft(null)
                          }}
                          onBlur={() => setRenameDraft(null)}
                          style={{
                            font: 'inherit',
                            fontSize: 17,
                            fontWeight: 750,
                            color: 'inherit',
                            background: 'rgba(0,0,0,.3)',
                            border: '1px solid rgba(255,255,255,.25)',
                            borderRadius: 8,
                            padding: '3px 10px',
                            maxWidth: 280
                          }}
                        />
                      )}
                      <StateChip state={selStatus.state} />
                    </div>
                    <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                      {selected.game === 'palworld' ? (
                        <>
                          <span className="chip on-banner">Palworld</span>
                          {selStatus.version && <span className="chip on-banner">{selStatus.version}</span>}
                          <span className="chip on-banner">UDP port {selected.port}</span>
                          {selected.communityServer && (
                            <span className="chip update" title="Listed in Palworld's community server browser">
                              Community
                            </span>
                          )}
                        </>
                      ) : (
                        <>
                          <span className={MODDABLE_KINDS.has(selected.kind) ? `chip loader-${selected.kind}` : 'chip on-banner'}>
                            {selected.kind}
                            {selected.loaderVersion ? ` ${selected.loaderVersion}` : ''}
                          </span>
                          <span className="chip on-banner">{selected.minecraftVersion}</span>
                          <span className="chip on-banner">port {selected.port}</span>
                          <span className="chip on-banner">{selected.memoryMax / 1024} GB</span>
                        </>
                      )}
                      {selected.packName && (
                        <span className="chip update" title="Created from this modpack">
                          {selected.packName}
                        </span>
                      )}
                    </div>
                    <div className="server-hero-sub">
                      created {timeAgo(selected.createdAt)}
                      {selStatus.state === 'running' &&
                        ` · ${
                          selStatus.players.length === 0
                            ? 'no players online'
                            : `online: ${selStatus.players.join(', ')}`
                        }`}
                    </div>
                  </div>
                  <div className="server-hero-actions">
                    <div className="row" style={{ gap: 4 }}>
                      <button className="icon-btn on-hero" title="Rename server" onClick={() => setRenameDraft(selected.name)}>
                        <IconEdit size={15} />
                      </button>
                      <button
                        className="icon-btn on-hero"
                        title="Open folder"
                        onClick={() => void window.elauncher.server.openFolder(selected.id)}
                      >
                        <IconFolder size={15} />
                      </button>
                      {MODDABLE_KINDS.has(selected.kind) && (
                        <button
                          className="icon-btn on-hero"
                          title="Export the matching client modpack (.mrpack) for players"
                          onClick={() => void exportPack(selected)}
                        >
                          <IconExport size={15} />
                        </button>
                      )}
                      <button className="icon-btn on-hero" title="Delete server" onClick={() => void remove(selected)}>
                        <IconTrash size={15} />
                      </button>
                    </div>
                    {selStatus.state === 'stopped' ? (
                      <button className="play" style={{ padding: '10px 26px' }} onClick={() => void start(selected.id)}>
                        <IconPlay size={14} /> Start
                      </button>
                    ) : (
                      <div className="row" style={{ gap: 8 }}>
                        <button
                          className="danger"
                          style={{ padding: '10px 22px' }}
                          disabled={selStatus.state === 'stopping'}
                          onClick={() => void window.elauncher.server.stop(selected.id)}
                        >
                          <IconStop size={14} /> {selStatus.state === 'stopping' ? 'Stopping…' : 'Stop'}
                        </button>
                        {/* the way out when a server ignores `stop` — offered only once
                            a normal stop is already underway, so it stays a last resort */}
                        {selStatus.state === 'stopping' && (
                          <button
                            className="ghost"
                            style={{ padding: '10px 16px' }}
                            title="Kill the server process now, without waiting for it to save"
                            onClick={() => void forceStop(selected)}
                          >
                            Force stop
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {selStatus.error && (
                  <div className="error-banner server-hero-error">
                    <IconAlert size={15} />
                    <span>{selStatus.error}</span>
                  </div>
                )}
              </div>

              <div className="tabs server-tabs">
                {SERVER_TABS.filter((t) => selected.game !== 'palworld' || t.id !== 'mods').map((t) => (
                  <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
                    {t.icon} {t.id === 'mods' && selected.kind === 'paper' ? 'Plugins' : t.label}
                  </button>
                ))}
              </div>

              {tab === 'overview' && (
                <>
                  <div className="overview-stats">
                    <div className="stat-tile">
                      <div
                        className="stat-icon"
                        style={
                          selStatus.state === 'running'
                            ? { background: 'var(--green-soft)', color: 'var(--green)' }
                            : undefined
                        }
                      >
                        <IconZap size={18} />
                      </div>
                      <div>
                        <div className="stat-value stat-value-sm">{STATE_LABEL[selStatus.state]}</div>
                        <div className="stat-label">Status</div>
                      </div>
                    </div>
                    <div className="stat-tile">
                      <div className="stat-icon">
                        <IconUsers size={18} />
                      </div>
                      <div>
                        <div className="stat-value stat-value-sm">{selStatus.players.length}</div>
                        <div className="stat-label">Players online</div>
                      </div>
                    </div>
                    <AddressTile
                      address={selStatus.tunnelAddress ?? `localhost:${selected.port}`}
                      isPublic={Boolean(selStatus.tunnelAddress)}
                    />
                    {selStatus.memoryMB != null ? (
                      <div className="stat-tile">
                        <div className="stat-icon">
                          <IconGauge size={18} />
                        </div>
                        <div>
                          <div className="stat-value stat-value-sm">{(selStatus.memoryMB / 1024).toFixed(1)} GB</div>
                          <div className="stat-label">
                            Memory in use{selStatus.cpuPercent != null ? ` · ${selStatus.cpuPercent}% CPU` : ''}
                          </div>
                        </div>
                      </div>
                    ) : (
                      selected.game !== 'palworld' && (
                        <div className="stat-tile">
                          <div className="stat-icon">
                            <IconGauge size={18} />
                          </div>
                          <div>
                            <div className="stat-value stat-value-sm">{selected.memoryMax / 1024} GB</div>
                            <div className="stat-label">Dedicated memory</div>
                          </div>
                        </div>
                      )
                    )}
                    {selStatus.startedAt != null && (
                      <div className="stat-tile">
                        <div className="stat-icon">
                          <IconClock size={18} />
                        </div>
                        <div>
                          <div className="stat-value stat-value-sm">{fmtUptime(Date.now() - selStatus.startedAt)}</div>
                          <div className="stat-label">Uptime</div>
                        </div>
                      </div>
                    )}
                  </div>
                  <Console serverId={selected.id} running={selRunning} palworld={selected.game === 'palworld'} />
                  <ShareCard server={selected} status={selStatus} />
                </>
              )}
              {tab === 'mods' && <ServerModsCard server={selected} running={selRunning} />}
              {tab === 'files' && <FilesTab server={selected} />}
              {tab === 'players' &&
                (selected.game === 'palworld' ? (
                  <PalworldPlayersTab server={selected} running={selStatus.state === 'running'} />
                ) : (
                  <PlayersTab server={selected} online={selStatus.players} running={selStatus.state === 'running'} />
                ))}
              {tab === 'settings' && (
                <>
                  {selected.game === 'palworld' ? <PalworldSettingsTab server={selected} /> : <PropertiesCard server={selected} />}
                  <AutomationCard server={selected} />
                </>
              )}
              {tab === 'access' && <AccessTab server={selected} />}
            </div>
          )}
        </div>
      )}

      <RemoteServers />
      <HostReadiness />

      {showCreate && (
        <CreateServerModal
          onClose={() => setShowCreate(false)}
          onCreated={(server) => {
            setShowCreate(false)
            void refresh().then(() => setSelectedId(server.id))
          }}
        />
      )}
    </div>
  )
}
