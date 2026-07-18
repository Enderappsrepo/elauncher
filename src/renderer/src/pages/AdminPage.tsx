import { useCallback, useEffect, useState } from 'react'
import type { CloudPackDetails, CloudProfile, HostReport, LauncherNewsItem, LocalServer } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { formatBytes, timeAgo, tileGradient } from '../fmt'
import {
  IconAlert,
  IconBox,
  IconEdit,
  IconGauge,
  IconNews,
  IconPlus,
  IconRefresh,
  IconServer,
  IconShield,
  IconTrash,
  IconZap
} from '../icons'

type Health = 'smooth' | 'fair' | 'poor' | null
interface LiveState {
  state: string
  memoryMB: number | null
  cpuPercent: number | null
  health: Health
}

/** Admin capacity + performance dashboard: how the host is doing and how many more servers fit. */
function CapacityTab(): React.JSX.Element {
  const [report, setReport] = useState<HostReport | null>(null)
  const [servers, setServers] = useState<LocalServer[]>([])
  const [states, setStates] = useState<Record<string, LiveState>>({})

  const load = useCallback(() => {
    window.elauncher.host.report().then(setReport).catch(() => {})
    window.elauncher.server.list().then(setServers).catch(() => {})
    window.elauncher.server.getStates().then((s) => setStates(s as Record<string, LiveState>)).catch(() => {})
  }, [])

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [load])

  if (!report) return <div className="skeleton" style={{ height: 260 }} />

  const totalGB = report.specs.ramGB
  const threads = report.specs.threads
  const OS_RESERVE = 4
  // allocated footprint of a running server (palworld self-sizes ~14 GB; minecraft reserves its heap)
  const allocGB = (s: LocalServer): number => (s.game === 'palworld' ? 14 : Math.max(2, s.memoryMax / 1024 || 4))

  const running = servers.filter((s) => (states[s.id]?.state ?? 'stopped') !== 'stopped')
  const committedGB = OS_RESERVE + running.reduce((sum, s) => sum + allocGB(s), 0)
  const freeGB = Math.max(0, totalGB - committedGB)
  const usedPct = Math.min(100, Math.round((committedGB / Math.max(1, totalGB)) * 100))

  // live CPU across running servers, and the worst health reading
  const cpuSum = running.reduce((sum, s) => sum + (states[s.id]?.cpuPercent ?? 0), 0)
  const healths = running.map((s) => states[s.id]?.health).filter(Boolean) as Health[]
  const anyPoor = healths.includes('poor')
  const anyFair = healths.includes('fair')

  // capacity headroom — the smaller of what RAM and CPU threads allow
  const threadsFree = threads - 2 - running.length * 2
  const moreMcByRam = Math.floor(freeGB / 4)
  const morePalByRam = Math.floor(freeGB / 14)
  const moreByThreads = Math.max(0, Math.floor(threadsFree / 2))
  const moreMc = Math.max(0, Math.min(moreMcByRam, moreByThreads))
  const morePal = Math.max(0, Math.min(morePalByRam, Math.floor(moreByThreads / 2)))

  const verdict: { label: string; color: string; note: string } =
    freeGB < 2 || anyPoor || cpuSum > 90 || report.specs.freeRamGB < 1.5
      ? { label: 'Under pressure', color: 'var(--red)', note: 'At or near capacity — avoid adding servers; consider a scheduled restart or lower view-distance on busy ones.' }
      : freeGB < 4 || anyFair || cpuSum > 70
        ? { label: 'Getting busy', color: '#fbbf24', note: 'Working, but with limited headroom. Keep an eye on memory and CPU before taking on more.' }
        : { label: 'Healthy', color: 'var(--green)', note: 'Plenty of headroom — comfortable to run more servers.' }

  const bar = (pct: number, color: string): React.JSX.Element => (
    <div style={{ height: 10, borderRadius: 99, background: 'var(--bg-hover)', overflow: 'hidden' }}>
      <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width .4s' }} />
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {/* verdict banner */}
      <div className="card settings-section" style={{ borderColor: verdict.color }}>
        <div className="row" style={{ gap: 12 }}>
          <span className="stat-icon" style={{ background: 'transparent', color: verdict.color }}>
            <IconGauge size={22} />
          </span>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 18, fontWeight: 750, color: verdict.color }}>{verdict.label}</div>
            <div className="small muted">{verdict.note}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 800 }}>
              {running.length}
              <span className="faint" style={{ fontSize: 14, fontWeight: 500 }}>
                {' '}
                / {servers.length}
              </span>
            </div>
            <div className="small faint">servers running</div>
          </div>
        </div>
      </div>

      {/* resource meters */}
      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconZap size={15} /> Host resources
          </span>
          <span className="small faint">
            {report.specs.cpuModel} · {threads} threads · {totalGB} GB
          </span>
        </div>
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <label style={{ margin: 0 }}>Memory committed</label>
            <span className="small faint">
              {committedGB.toFixed(0)} / {totalGB} GB · {freeGB.toFixed(0)} GB free
            </span>
          </div>
          {bar(usedPct, usedPct > 85 ? 'var(--red)' : usedPct > 65 ? '#fbbf24' : 'var(--green)')}
        </div>
        <div className="field">
          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
            <label style={{ margin: 0 }}>CPU load (running servers)</label>
            <span className="small faint">{Math.round(cpuSum)}% of one machine</span>
          </div>
          {bar(Math.min(100, cpuSum), cpuSum > 90 ? 'var(--red)' : cpuSum > 70 ? '#fbbf24' : 'var(--green)')}
        </div>
        {report.specs.diskType === 'HDD' && (
          <div className="hint" style={{ color: 'var(--red)' }}>
            Mechanical hard drive — world saves and chunk loading will stutter under load. An SSD is the biggest upgrade for hosting.
          </div>
        )}
      </div>

      {/* how many more can run */}
      <div className="card settings-section">
        <div className="section-title">
          <span className="row" style={{ gap: 9 }}>
            <IconServer size={15} /> Room for more servers
          </span>
          <span className="small faint">rough estimate</span>
        </div>
        <div className="props-grid">
          <div className="stat-tile">
            <div className="stat-icon">
              <IconBox size={18} />
            </div>
            <div>
              <div className="stat-value stat-value-sm">{moreMc}</div>
              <div className="stat-label">more Minecraft (~4 GB each)</div>
            </div>
          </div>
          <div className="stat-tile">
            <div className="stat-icon">
              <IconBox size={18} />
            </div>
            <div>
              <div className="stat-value stat-value-sm">{morePal}</div>
              <div className="stat-label">more Palworld (~14 GB each)</div>
            </div>
          </div>
        </div>
        <div className="hint">
          Based on {freeGB.toFixed(0)} GB free memory and {Math.max(0, threadsFree)} spare CPU threads. Real capacity depends on
          player counts, mods, and base sizes — treat these as a ceiling, not a promise.
        </div>
      </div>

      {/* per-server health */}
      {running.length > 0 && (
        <div className="card settings-section">
          <div className="section-title">
            <span className="row" style={{ gap: 9 }}>
              <IconServer size={15} /> Running servers
            </span>
          </div>
          {running.map((s) => {
            const st = states[s.id]
            const h = st?.health
            const color = h === 'poor' ? 'var(--red)' : h === 'fair' ? '#fbbf24' : 'var(--green)'
            const label = h === 'poor' ? 'Struggling' : h === 'fair' ? 'Busy' : 'Smooth'
            return (
              <div key={s.id} className="row" style={{ gap: 10, padding: '8px 0', borderTop: '1px solid rgba(255,255,255,.06)' }}>
                <span style={{ fontWeight: 650, flex: 1, minWidth: 0 }}>{s.name}</span>
                <span className="small faint">{s.game === 'palworld' ? 'Palworld' : s.kind}</span>
                {st?.memoryMB != null && <span className="small faint">{(st.memoryMB / 1024).toFixed(1)} GB</span>}
                {st?.cpuPercent != null && <span className="small faint">{st.cpuPercent}% CPU</span>}
                <span className="chip" style={{ color, borderColor: 'transparent', background: 'rgba(255,255,255,.05)' }}>
                  {label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* host limitations from the estimator */}
      {report.limitations.length > 0 && (
        <div className="card settings-section">
          <div className="section-title">
            <span className="row" style={{ gap: 9 }}>
              <IconAlert size={15} /> Things to watch
            </span>
          </div>
          {report.limitations.map((limit, i) => (
            <div key={i} className="hint" style={{ marginTop: 4 }}>
              • {limit}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function MembersTab(): React.JSX.Element {
  const { cloudUser } = useAppState()
  const toast = useToast()
  const [profiles, setProfiles] = useState<CloudProfile[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.elauncher.cloud.admin
      .listProfiles()
      .then(setProfiles)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => load(), [load])

  const toggleAdmin = async (profile: CloudProfile): Promise<void> => {
    setBusyId(profile.id)
    const result = await window.elauncher.cloud.admin.setAdmin(profile.id, !profile.isAdmin)
    setBusyId(null)
    if (result.ok) {
      toast.success(profile.isAdmin ? `${profile.username} is no longer an admin` : `${profile.username} is now an admin`)
      load()
    } else {
      toast.error(result.error ?? 'Could not change admin status')
    }
  }

  if (error) {
    return (
      <div className="error-banner">
        <IconAlert size={16} />
        <span>{error}</span>
      </div>
    )
  }

  if (profiles === null) {
    return (
      <div className="mod-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 64 }} />
        ))}
      </div>
    )
  }

  return (
    <div>
      <div className="muted small" style={{ marginBottom: 14 }}>
        {profiles.length} member{profiles.length === 1 ? '' : 's'} ·{' '}
        {profiles.filter((p) => p.isAdmin).length} admin{profiles.filter((p) => p.isAdmin).length === 1 ? '' : 's'}
      </div>
      <div className="mod-list">
        {profiles.map((p) => (
          <div key={p.id} className="mod-row">
            <div
              className="tile"
              style={{ width: 40, height: 40, fontSize: 16, background: tileGradient(p.id) }}
            >
              {p.username.charAt(0).toUpperCase()}
            </div>
            <div className="info">
              <h4>
                {p.username}
                {p.id === cloudUser?.id && <span className="faint small"> (you)</span>}
              </h4>
              <div className="meta">
                <span>Joined {timeAgo(new Date(p.createdAt).getTime())}</span>
                {p.isAdmin && (
                  <span style={{ color: 'var(--accent-hover)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                    <IconShield size={11} /> admin
                  </span>
                )}
              </div>
            </div>
            <button
              className="ghost"
              disabled={busyId === p.id || p.id === cloudUser?.id}
              title={p.id === cloudUser?.id ? "You can't change your own admin access" : undefined}
              onClick={() => void toggleAdmin(p)}
            >
              {busyId === p.id ? 'Saving…' : p.isAdmin ? 'Remove admin' : 'Make admin'}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}

function PackEditor({ pack, onChanged }: { pack: CloudPackDetails; onChanged: () => void }): React.JSX.Element {
  const toast = useToast()
  const [name, setName] = useState(pack.name)
  const [description, setDescription] = useState(pack.description)
  const [busy, setBusy] = useState(false)
  const dirty = name !== pack.name || description !== pack.description

  const save = async (): Promise<void> => {
    setBusy(true)
    const result = await window.elauncher.cloud.admin.updatePack(pack.id, name, description)
    setBusy(false)
    if (result.ok) {
      toast.success('Pack details saved')
      onChanged()
    } else {
      toast.error(result.error ?? 'Save failed')
    }
  }

  const deleteVersion = async (versionId: string, version: string): Promise<void> => {
    if (!confirm(`Delete version ${version} of "${pack.name}"? Players on it can no longer re-download it.`)) return
    const result = await window.elauncher.cloud.admin.deleteVersion(versionId)
    if (result.ok) {
      toast.success(`Deleted version ${version}`)
      onChanged()
    } else {
      toast.error(result.error ?? 'Delete failed')
    }
  }

  const deletePack = async (): Promise<void> => {
    if (!confirm(`Delete "${pack.name}" and all ${pack.versions.length} version(s)? This cannot be undone.`)) return
    const result = await window.elauncher.cloud.admin.deletePack(pack.id)
    if (result.ok) {
      toast.success(`Deleted "${pack.name}"`)
      onChanged()
    } else {
      toast.error(result.error ?? 'Delete failed')
    }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
        <div className="tile" style={{ background: tileGradient(pack.id) }}>
          {pack.name.charAt(0).toUpperCase()}
        </div>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <input
            value={description}
            placeholder="Description"
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="row" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 6 }}>
          <button className="primary" disabled={!dirty || busy || !name.trim()} onClick={() => void save()}>
            {busy ? 'Saving…' : 'Save'}
          </button>
          <button className="danger" onClick={() => void deletePack()}>
            <IconTrash size={13} /> Delete pack
          </button>
        </div>
      </div>
      <div className="row" style={{ gap: 6 }}>
        <span className={`chip loader-${pack.loader}`}>{pack.loader}</span>
        <span className="chip">{pack.minecraftVersion}</span>
        <span className="small faint">Updated {timeAgo(new Date(pack.updatedAt).getTime())}</span>
      </div>
      <div>
        <div className="section-label" style={{ margin: '0 0 8px' }}>
          Versions
        </div>
        {pack.versions.length === 0 ? (
          <div className="muted small">No versions published.</div>
        ) : (
          <div className="mod-list">
            {pack.versions.map((v, idx) => (
              <div key={v.id} className="mod-row" style={{ padding: '10px 14px' }}>
                <div className="info">
                  <h4>
                    v{v.version}
                    {idx === 0 && <span style={{ color: 'var(--green)', fontSize: 11 }}> latest</span>}
                  </h4>
                  <div className="meta">
                    <span>{timeAgo(new Date(v.createdAt).getTime())}</span>
                    <span>{formatBytes(v.fileSize)}</span>
                    {v.changelog && <span>{v.changelog}</span>}
                  </div>
                </div>
                <button
                  className="icon-btn"
                  title={`Delete version ${v.version}`}
                  onClick={() => void deleteVersion(v.id, v.version)}
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PacksTab(): React.JSX.Element {
  const [packs, setPacks] = useState<CloudPackDetails[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.elauncher.cloud.admin
      .listPacks()
      .then(setPacks)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => load(), [load])

  if (error) {
    return (
      <div className="error-banner">
        <IconAlert size={16} />
        <span>{error}</span>
      </div>
    )
  }

  if (packs === null) {
    return (
      <div className="mod-list">
        {[0, 1].map((i) => (
          <div key={i} className="skeleton" style={{ height: 160 }} />
        ))}
      </div>
    )
  }

  if (packs.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconBox size={28} />
        </div>
        <h2>No modpacks published</h2>
        <p>Publish one from any instance: Menu &gt; Publish to cloud.</p>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      {packs.map((pack) => (
        <PackEditor key={pack.id} pack={pack} onChanged={load} />
      ))}
    </div>
  )
}

function ArticleEditor({
  article,
  onDone,
  onCancel
}: {
  article: LauncherNewsItem | null
  onDone: () => void
  onCancel: () => void
}): React.JSX.Element {
  const toast = useToast()
  const [title, setTitle] = useState(article?.title ?? '')
  const [body, setBody] = useState(article?.body ?? '')
  const [imageUrl, setImageUrl] = useState(article?.imageUrl ?? '')
  const [linkUrl, setLinkUrl] = useState(article?.linkUrl ?? '')
  const [busy, setBusy] = useState(false)

  const publish = async (): Promise<void> => {
    setBusy(true)
    const result = await window.elauncher.cloud.admin.publishNews({
      id: article?.id,
      title,
      body,
      imageUrl: imageUrl || undefined,
      linkUrl: linkUrl || undefined
    })
    setBusy(false)
    if (result.ok) {
      toast.success(article ? 'Article updated' : 'Article published')
      onDone()
    } else {
      toast.error(result.error ?? 'Publish failed')
    }
  }

  return (
    <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div className="section-label" style={{ margin: 0 }}>
        {article ? 'Edit article' : 'New article'}
      </div>
      <input
        autoFocus
        placeholder="Title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      <textarea
        className="raw-editor"
        style={{ minHeight: 110, fontFamily: 'inherit' }}
        placeholder="Write your announcement… (shown as the article text)"
        value={body}
        onChange={(e) => setBody(e.target.value)}
      />
      <div className="row" style={{ gap: 8 }}>
        <input
          style={{ flex: 1 }}
          placeholder="Image URL (optional)"
          value={imageUrl}
          onChange={(e) => setImageUrl(e.target.value)}
        />
        <input
          style={{ flex: 1 }}
          placeholder="Read more link (optional)"
          value={linkUrl}
          onChange={(e) => setLinkUrl(e.target.value)}
        />
      </div>
      {imageUrl.trim() && (
        <div className="news-image" style={{ height: 120, borderRadius: 10 }}>
          <img
            src={imageUrl.trim()}
            alt=""
            onError={(e) => ((e.target as HTMLImageElement).style.display = 'none')}
          />
        </div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <button className="ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="primary" disabled={busy || !title.trim()} onClick={() => void publish()}>
          {busy ? 'Publishing…' : article ? 'Save changes' : 'Publish'}
        </button>
      </div>
    </div>
  )
}

function NewsTab(): React.JSX.Element {
  const toast = useToast()
  const [articles, setArticles] = useState<LauncherNewsItem[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  // null = closed, 'new' = composer, otherwise the id being edited
  const [editing, setEditing] = useState<string | null>(null)

  const load = useCallback(() => {
    setError(null)
    window.elauncher.cloud.admin
      .listNews()
      .then(setArticles)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => load(), [load])

  const deleteArticle = async (article: LauncherNewsItem): Promise<void> => {
    if (!confirm(`Delete the article "${article.title}"? This cannot be undone.`)) return
    const result = await window.elauncher.cloud.admin.deleteNews(article.id)
    if (result.ok) {
      toast.success('Article deleted')
      load()
    } else {
      toast.error(result.error ?? 'Delete failed')
    }
  }

  if (error) {
    return (
      <div className="error-banner">
        <IconAlert size={16} />
        <span>{error}</span>
      </div>
    )
  }

  if (articles === null) {
    return (
      <div className="mod-list">
        {[0, 1, 2].map((i) => (
          <div key={i} className="skeleton" style={{ height: 64 }} />
        ))}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <div className="muted small">
          {articles.length} article{articles.length === 1 ? '' : 's'} — shown to every player on the Home page.
        </div>
        {editing === null && (
          <button className="primary" onClick={() => setEditing('new')}>
            <IconPlus size={14} /> New article
          </button>
        )}
      </div>

      {editing === 'new' && (
        <ArticleEditor
          article={null}
          onCancel={() => setEditing(null)}
          onDone={() => {
            setEditing(null)
            load()
          }}
        />
      )}

      {articles.length === 0 && editing === null ? (
        <div className="empty-state" style={{ padding: '50px 20px' }}>
          <div className="empty-icon">
            <IconNews size={28} />
          </div>
          <h2>No articles yet</h2>
          <p>Publish your first announcement — it appears at the top of everyone&apos;s Home page.</p>
        </div>
      ) : (
        <div className="mod-list">
          {articles.map((a) =>
            editing === a.id ? (
              <ArticleEditor
                key={a.id}
                article={a}
                onCancel={() => setEditing(null)}
                onDone={() => {
                  setEditing(null)
                  load()
                }}
              />
            ) : (
              <div key={a.id} className="mod-row">
                {a.imageUrl ? (
                  <img
                    src={a.imageUrl}
                    alt=""
                    style={{ width: 64, height: 40, objectFit: 'cover', borderRadius: 8, flexShrink: 0 }}
                  />
                ) : (
                  <div
                    className="tile"
                    style={{ width: 64, height: 40, fontSize: 14, borderRadius: 8, background: tileGradient(a.id) }}
                  >
                    <IconNews size={16} />
                  </div>
                )}
                <div className="info">
                  <h4>{a.title}</h4>
                  <div className="meta">
                    <span>{timeAgo(new Date(a.createdAt).getTime())}</span>
                    {a.authorName && <span>by {a.authorName}</span>}
                    {a.body && <span>{a.body.length > 80 ? `${a.body.slice(0, 80)}…` : a.body}</span>}
                  </div>
                </div>
                <button className="icon-btn" title="Edit article" onClick={() => setEditing(a.id)}>
                  <IconEdit size={15} />
                </button>
                <button className="icon-btn" title="Delete article" onClick={() => void deleteArticle(a)}>
                  <IconTrash size={15} />
                </button>
              </div>
            )
          )}
        </div>
      )}
    </div>
  )
}

export default function AdminPage(): React.JSX.Element {
  const { cloudUser } = useAppState()
  const [tab, setTab] = useState<'capacity' | 'members' | 'packs' | 'news'>('capacity')
  const [reloadKey, setReloadKey] = useState(0)

  if (!cloudUser?.isAdmin) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconShield size={28} />
        </div>
        <h2>Admins only</h2>
        <p>Sign in with an admin account to manage members, modpacks and news.</p>
      </div>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Admin</h1>
          <p className="muted" style={{ marginTop: 4 }}>
            Hosting capacity, members, the shared modpack library, and launcher news.
          </p>
        </div>
        <button className="ghost" onClick={() => setReloadKey((k) => k + 1)}>
          <IconRefresh size={14} /> Refresh
        </button>
      </div>
      <div className="tabs">
        <button className={tab === 'capacity' ? 'active' : ''} onClick={() => setTab('capacity')}>
          Capacity
        </button>
        <button className={tab === 'members' ? 'active' : ''} onClick={() => setTab('members')}>
          Members
        </button>
        <button className={tab === 'packs' ? 'active' : ''} onClick={() => setTab('packs')}>
          Modpacks
        </button>
        <button className={tab === 'news' ? 'active' : ''} onClick={() => setTab('news')}>
          News
        </button>
      </div>
      <div key={reloadKey}>
        {tab === 'capacity' ? (
          <CapacityTab />
        ) : tab === 'members' ? (
          <MembersTab />
        ) : tab === 'packs' ? (
          <PacksTab />
        ) : (
          <NewsTab />
        )}
      </div>
    </div>
  )
}
