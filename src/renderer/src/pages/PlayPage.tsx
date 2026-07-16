import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { GameSession, Instance, SavedServerEntry, ServerPingResult } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { IconCheck, IconCloud, IconCopy, IconGlobe, IconPlay, IconPlus, IconRefresh, IconServer, IconStop, IconTrash, IconUsers, IconWifi, IconZap } from '../icons'
import Select from '../components/Select'

const E4MC_RE = /\b(?:[a-z0-9-]+\.)+e4mc\.link\b/i

/** Add (or replace) a server entry in an instance's list without duplicating the address. */
async function addServer(instanceId: string, name: string, ip: string): Promise<void> {
  const existing = await window.elauncher.servers.list(instanceId)
  const deduped = existing.filter((s) => s.ip !== ip)
  const result = await window.elauncher.servers.save(instanceId, [...deduped, { name, ip }])
  if (!result.ok) throw new Error(result.error ?? 'Could not update the server list')
}

function loaderChip(loader?: string): React.JSX.Element | null {
  if (!loader) return null
  return <span className={`chip loader-${loader}`}>{loader}</span>
}

/** Modal to pick which instance a session's address gets added to. */
function JoinModal({
  session,
  instances,
  onClose,
  onJoined
}: {
  session: GameSession
  instances: Instance[]
  onClose: () => void
  onJoined: (instanceId: string) => void
}): React.JSX.Element {
  const toast = useToast()
  const { refreshInstances } = useAppState()
  // prefer an instance that matches the session's version + loader
  const preferred =
    instances.find((i) => i.minecraftVersion === session.minecraftVersion && i.loader === session.loader) ??
    instances.find((i) => i.minecraftVersion === session.minecraftVersion) ??
    instances[0]
  const [target, setTarget] = useState(preferred?.id ?? '')
  const [busy, setBusy] = useState(false)

  const serverName = `${session.hostName}: ${session.name}`.slice(0, 60)

  const addToInstance = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    try {
      await addServer(target, serverName, session.address)
      toast.success('Added to your server list — launch and join from Multiplayer')
      onJoined(target)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const joinNow = async (): Promise<void> => {
    if (!target) return
    setBusy(true)
    try {
      await addServer(target, serverName, session.address)
      const res = await window.elauncher.game.launch(target, session.address)
      if (!res.ok) throw new Error(res.error ?? 'Could not launch the game')
      toast.success(`Launching — connecting to ${session.hostName}'s world…`)
      onJoined(target)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const installAndJoin = async (): Promise<void> => {
    if (!session.cloudPackId) return
    setBusy(true)
    try {
      const inst = await window.elauncher.cloud.install(session.cloudPackId)
      await refreshInstances()
      await addServer(inst.id, serverName, session.address)
      toast.success(`Installed the pack and added ${session.hostName}'s server`)
      onJoined(inst.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" style={{ width: 460 }} onClick={(e) => e.stopPropagation()}>
        <h2>Join {session.hostName ? `${session.hostName}'s session` : session.name}</h2>
        <p className="muted small" style={{ margin: '2px 0 4px' }}>
          {session.name} · {session.minecraftVersion ?? '?'} {session.loader ?? ''}
        </p>
        <div className="field">
          <label>Address</label>
          <div className="join-addr">
            <IconGlobe size={14} /> {session.address}
          </div>
        </div>
        {instances.length > 0 ? (
          <div className="field">
            <label>Add to which instance?</label>
            <Select
              value={target}
              onChange={setTarget}
              options={instances.map((i) => ({ value: i.id, label: `${i.name} (${i.minecraftVersion} ${i.loader})` }))}
            />
            <div className="hint">The address is written into that instance's in-game server list.</div>
          </div>
        ) : (
          <div className="hint">You have no instances yet — install the pack below to create one.</div>
        )}
        <div className="hint">
          <b>Join now</b> launches the game and connects automatically. <b>Add to list</b> just saves it for later.
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4, flexWrap: 'wrap' }}>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          {session.cloudPackId && (
            <button className="ghost" disabled={busy} onClick={() => void installAndJoin()}>
              <IconCloud size={14} /> Install pack & join
            </button>
          )}
          <button className="ghost" disabled={busy || !target} onClick={() => void addToInstance()}>
            <IconCheck size={14} /> Add to list
          </button>
          <button className="primary" disabled={busy || !target} onClick={() => void joinNow()}>
            <IconPlay size={14} /> Join now
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PlayPage(): React.JSX.Element {
  const { instances, cloudAvailable, cloudUser } = useAppState()
  const toast = useToast()
  const navigate = useNavigate()

  const [instanceId, setInstanceId] = useState(instances[0]?.id ?? '')
  const instance = instances.find((i) => i.id === instanceId) ?? instances[0]
  const [address, setAddress] = useState('')
  const [sessionName, setSessionName] = useState('')
  const [enabling, setEnabling] = useState(false)
  const [e4mcReady, setE4mcReady] = useState(false)
  const [tunneling, setTunneling] = useState(false)
  const [publishing, setPublishing] = useState(false)
  const [mySession, setMySession] = useState<GameSession | null>(null)
  const [sessions, setSessions] = useState<GameSession[] | null>(null)
  const [joinTarget, setJoinTarget] = useState<GameSession | null>(null)

  useEffect(() => {
    if (instance && !sessionName) setSessionName(`${instance.name}`)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [instance?.id])

  // auto-detect an e4mc address from the hosting instance's game log
  useEffect(() => {
    if (!instance) return
    window.elauncher.game.getLogs(instance.id).then((lines) => {
      const hit = lines.map((l) => l.match(E4MC_RE)?.[0]).find(Boolean)
      if (hit) setAddress((a) => a || hit!)
    })
    const off = window.elauncher.game.onLog((e) => {
      if (e.instanceId !== instance.id) return
      const hit = e.line.match(E4MC_RE)?.[0]
      if (hit) setAddress((a) => a || hit)
    })
    return off
  }, [instance?.id])

  const loadSessions = useCallback(() => {
    if (!cloudUser) {
      setSessions([])
      return
    }
    window.elauncher.cloud.sessions
      .list()
      .then((list) => {
        setSessions(list)
        setMySession(list.find((s) => s.isMine) ?? null)
      })
      .catch(() => setSessions([]))
  }, [cloudUser])

  useEffect(() => {
    loadSessions()
    const t = setInterval(loadSessions, 30_000)
    return () => clearInterval(t)
  }, [loadSessions])

  const enableE4mc = async (): Promise<void> => {
    if (!instance) return
    setEnabling(true)
    try {
      const res = await window.elauncher.host.enableE4mc(instance.id)
      if (res.ok) {
        setE4mcReady(true)
        toast.success(res.alreadyInstalled ? 'e4mc is already installed' : 'e4mc installed — launch and Open to LAN')
      } else toast.error(res.error ?? 'Could not enable e4mc')
    } finally {
      setEnabling(false)
    }
  }

  const startTunnel = async (): Promise<void> => {
    setTunneling(true)
    try {
      const res = await window.elauncher.host.startTunnel()
      if (res.ok && res.address) {
        setAddress(res.address)
        toast.success('Tunnel is live — publish or share the address')
      } else toast.error(res.error ?? 'Could not start the tunnel')
    } finally {
      setTunneling(false)
    }
  }

  const publish = async (): Promise<void> => {
    if (!instance) return
    setPublishing(true)
    try {
      const res = await window.elauncher.cloud.sessions.publish({
        name: sessionName.trim() || instance.name,
        address: address.trim(),
        minecraftVersion: instance.minecraftVersion,
        loader: instance.loader
      })
      if (res.ok && res.session) {
        setMySession(res.session)
        toast.success('Session published — your friends can see it now')
        loadSessions()
      } else toast.error(res.error ?? 'Could not publish the session')
    } finally {
      setPublishing(false)
    }
  }

  const stopHosting = async (): Promise<void> => {
    await window.elauncher.cloud.sessions.end()
    await window.elauncher.host.stopTunnel()
    setMySession(null)
    toast.success('Session ended')
    loadSessions()
  }

  const copyAddress = (value: string): void => {
    void navigator.clipboard.writeText(value)
    toast.success('Address copied')
  }

  const others = useMemo(() => (sessions ?? []).filter((s) => !s.isMine), [sessions])
  const modded = instance && instance.loader !== 'vanilla'

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Play Together</h1>
          <p className="muted small" style={{ marginTop: 2 }}>
            Host a world for friends and let them join in one click — no port-forwarding or dedicated server.
          </p>
        </div>
      </div>

      <div className="play-layout">
        {/* ---------------- Host ---------------- */}
        <div className="card settings-section">
          <div className="section-title">
            <span className="row" style={{ gap: 9 }}>
              <IconWifi size={16} /> Host a session
            </span>
          </div>

          {mySession ? (
            <>
              <div className="pill-note" style={{ background: 'var(--green-soft)', borderColor: 'rgba(52,211,153,0.25)', color: 'var(--green)' }}>
                <IconCheck size={15} /> You're live as “{mySession.name}”. Friends can see and join this session.
              </div>
              <div className="field">
                <label>Join address</label>
                <div className="join-addr">
                  <IconGlobe size={14} /> {mySession.address}
                  <button className="icon-btn" title="Copy" style={{ marginLeft: 'auto' }} onClick={() => copyAddress(mySession.address)}>
                    <IconCopy size={14} />
                  </button>
                </div>
              </div>
              <button className="danger" style={{ alignSelf: 'flex-start' }} onClick={() => void stopHosting()}>
                <IconStop size={14} /> Stop hosting
              </button>
            </>
          ) : (
            <>
              {instances.length === 0 ? (
                <div className="hint">Create an instance first, then come back to host it for friends.</div>
              ) : (
                <>
                  <div className="field">
                    <label>Instance</label>
                    <Select
                      value={instance?.id ?? ''}
                      onChange={setInstanceId}
                      options={instances.map((i) => ({ value: i.id, label: `${i.name} (${i.minecraftVersion} ${i.loader})` }))}
                    />
                  </div>

                  {modded ? (
                    <div className="host-step">
                      <div className="host-step-num">1</div>
                      <div style={{ flex: 1 }}>
                        <div className="host-step-title">Enable e4mc <span className="faint small">· recommended</span></div>
                        <div className="hint">
                          Installs the free e4mc mod. Launch, then in-game press Esc → <b>Open to LAN</b> → Start LAN
                          World — e4mc posts a public address in chat (and copies it) which we auto-detect below.
                        </div>
                        <button className="primary small" style={{ marginTop: 8 }} disabled={enabling || e4mcReady} onClick={() => void enableE4mc()}>
                          <IconZap size={13} /> {e4mcReady ? 'e4mc ready' : enabling ? 'Installing…' : 'Enable e4mc'}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="host-step">
                      <div className="host-step-num">1</div>
                      <div style={{ flex: 1 }}>
                        <div className="host-step-title">Start tunnel <span className="faint small">· vanilla · experimental</span></div>
                        <div className="hint">
                          Launch, then Esc → <b>Open to LAN</b> → Start LAN World, then start the tunnel. The launcher
                          exposes your world through the free bore.pub relay and fills in the address.
                        </div>
                        <button className="ghost small" style={{ marginTop: 8 }} disabled={tunneling} onClick={() => void startTunnel()}>
                          <IconGlobe size={13} /> {tunneling ? 'Starting…' : 'Start tunnel'}
                        </button>
                      </div>
                    </div>
                  )}

                  <div className="host-step">
                    <div className="host-step-num">2</div>
                    <div style={{ flex: 1 }}>
                      <div className="host-step-title">Publish the session</div>
                      <div className="field" style={{ marginTop: 6 }}>
                        <input value={sessionName} placeholder="Session name" onChange={(e) => setSessionName(e.target.value)} />
                      </div>
                      <div className="field">
                        <input
                          value={address}
                          placeholder="join address (auto-fills, or paste it here)"
                          onChange={(e) => setAddress(e.target.value)}
                        />
                      </div>
                      {cloudUser ? (
                        <button className="primary small" disabled={publishing || !address.trim()} onClick={() => void publish()}>
                          <IconUsers size={13} /> {publishing ? 'Publishing…' : 'Publish to friends'}
                        </button>
                      ) : (
                        <div className="hint">
                          {cloudAvailable
                            ? 'Sign in to your ELauncher account (sidebar) to publish sessions your friends can see.'
                            : 'The sessions board needs the ELauncher cloud (Supabase) set up — see the README. You can still share the address above manually.'}
                        </div>
                      )}
                    </div>
                  </div>
                </>
              )}
            </>
          )}
        </div>

        {/* ---------------- Live sessions ---------------- */}
        <div>
          <div className="home-section" style={{ margin: '0 0 14px' }}>
            <h2>
              <IconUsers size={16} /> Live sessions
            </h2>
            {others.length > 0 && <span className="small faint">{others.length} online</span>}
          </div>

          {!cloudUser ? (
            <div className="empty-state" style={{ padding: '48px 20px' }}>
              <div className="empty-icon">
                <IconCloud size={28} />
              </div>
              <h2>Sign in to see friends' sessions</h2>
              <p>Sessions are shared through your ELauncher cloud account. Sign in from the sidebar to see who's hosting.</p>
            </div>
          ) : sessions === null ? (
            <div className="mod-list">
              {[0, 1].map((i) => (
                <div key={i} className="skeleton" style={{ height: 74 }} />
              ))}
            </div>
          ) : others.length === 0 ? (
            <div className="empty-state" style={{ padding: '48px 20px' }}>
              <div className="empty-icon">
                <IconWifi size={28} />
              </div>
              <h2>No one's hosting right now</h2>
              <p>When a friend hosts a world, it shows up here and you can join in one click.</p>
            </div>
          ) : (
            <div className="mod-list">
              {others.map((s) => (
                <div className="server-row" key={s.id}>
                  <div className="server-icon-placeholder">
                    <IconServer size={19} />
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <h4 style={{ fontSize: 14, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {s.name}
                    </h4>
                    <div className="row" style={{ gap: 8, marginTop: 3 }}>
                      <span className="small faint">by {s.hostName}</span>
                      {loaderChip(s.loader)}
                      {s.minecraftVersion && <span className="chip on-banner">{s.minecraftVersion}</span>}
                      {s.cloudPackId && <span className="chip update">modpack</span>}
                    </div>
                  </div>
                  <button className="primary" style={{ minWidth: 92 }} onClick={() => setJoinTarget(s)}>
                    <IconPlay size={13} /> Join
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <ServerBrowser onJoin={setJoinTarget} />

      {joinTarget && (
        <JoinModal
          session={joinTarget}
          instances={instances}
          onClose={() => setJoinTarget(null)}
          onJoined={(id) => {
            setJoinTarget(null)
            navigate(`/instances/${id}`)
          }}
        />
      )}
    </div>
  )
}

/** Saved-server address book with live status pings — the server browser list. */
function ServerBrowser({ onJoin }: { onJoin: (session: GameSession) => void }): React.JSX.Element {
  const toast = useToast()
  const [entries, setEntries] = useState<SavedServerEntry[] | null>(null)
  const [pings, setPings] = useState<Record<string, ServerPingResult>>({})
  const [name, setName] = useState('')
  const [address, setAddress] = useState('')
  const [pinging, setPinging] = useState(false)

  const pingAll = useCallback((list: SavedServerEntry[]) => {
    setPinging(true)
    setPings({})
    void Promise.all(
      list.map((entry) =>
        window.elauncher.browser
          .ping(entry.address)
          .then((r) => setPings((p) => ({ ...p, [entry.id]: r })))
          .catch(() => {})
      )
    ).finally(() => setPinging(false))
  }, [])

  useEffect(() => {
    window.elauncher.browser
      .list()
      .then((list) => {
        setEntries(list)
        pingAll(list)
      })
      .catch(console.error)
  }, [pingAll])

  const add = async (): Promise<void> => {
    if (!address.trim()) return
    const res = await window.elauncher.browser.add(name, address)
    if (!res.ok) {
      toast.error(res.error ?? 'Could not save the server')
      return
    }
    setEntries(res.servers)
    setName('')
    setAddress('')
    const added = res.servers.find((s) => s.address === address.trim())
    if (added) {
      void window.elauncher.browser.ping(added.address).then((r) => setPings((p) => ({ ...p, [added.id]: r })))
    }
  }

  const remove = async (id: string): Promise<void> => {
    setEntries(await window.elauncher.browser.remove(id))
  }

  const joinEntry = (entry: SavedServerEntry): void =>
    onJoin({
      id: entry.id,
      hostId: '',
      hostName: '',
      name: entry.name,
      address: entry.address,
      createdAt: '',
      isMine: false
    })

  return (
    <div style={{ marginTop: 28 }}>
      <div className="home-section" style={{ margin: '0 0 14px' }}>
        <h2>
          <IconGlobe size={16} /> Server browser
        </h2>
        <button
          className="icon-btn"
          title="Refresh statuses"
          disabled={pinging || !entries?.length}
          onClick={() => entries && pingAll(entries)}
        >
          <IconRefresh size={14} />
        </button>
      </div>

      <form
        className="row"
        style={{ marginBottom: 14, flexWrap: 'wrap' }}
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input placeholder="Name (optional)" style={{ width: 180 }} value={name} onChange={(e) => setName(e.target.value)} />
        <input
          placeholder="Server address, e.g. play.example.com"
          style={{ flex: 1, minWidth: 220 }}
          value={address}
          onChange={(e) => setAddress(e.target.value)}
        />
        <button className="ghost" type="submit" disabled={!address.trim()}>
          <IconPlus size={14} /> Add server
        </button>
      </form>

      {entries === null ? (
        <div className="skeleton" style={{ height: 140 }} />
      ) : entries.length === 0 ? (
        <div className="hint">Add a server address above to track its status and join it in one click.</div>
      ) : (
        <div className="mod-list">
          {entries.map((entry) => {
            const ping = pings[entry.id]
            return (
              <div className="server-row" key={entry.id}>
                <div className="server-icon-placeholder">
                  <IconServer size={19} />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <h4 style={{ fontSize: 14, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {entry.name}
                  </h4>
                  <div className="row" style={{ gap: 8, marginTop: 3, flexWrap: 'wrap' }}>
                    <span className="server-addr">{entry.address}</span>
                    {!ping ? (
                      <span className="small faint">pinging…</span>
                    ) : ping.online ? (
                      <>
                        <span className="chip running">
                          <span className="dot" /> {ping.players?.online ?? 0}/{ping.players?.max ?? 0} online
                        </span>
                        {ping.latencyMs != null && <span className="small faint">{ping.latencyMs} ms</span>}
                        {ping.motd && (
                          <span className="small faint browser-motd" title={ping.motd}>
                            {ping.motd}
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="small" style={{ color: 'var(--red)' }}>
                        offline
                      </span>
                    )}
                  </div>
                </div>
                <button className="icon-btn" title="Remove" onClick={() => void remove(entry.id)}>
                  <IconTrash size={14} />
                </button>
                <button className="primary" style={{ minWidth: 92 }} onClick={() => joinEntry(entry)}>
                  <IconPlay size={13} /> Join
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
