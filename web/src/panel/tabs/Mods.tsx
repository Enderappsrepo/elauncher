import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Skeleton } from '@web/ui'
import type { TabProps } from './types'

/**
 * Mods (or plugins — Paper runs the Bukkit family) for one server.
 *
 * Search is Modrinth and is deliberately unfiltered by loader and Minecraft
 * version. The old panel narrowed the query with both, read from a per-server
 * `info` request that is not part of this panel's action contract, so this tab
 * cannot know either. That turns out to be safe rather than sloppy: the host
 * re-resolves every install against the server's real loader and version and
 * refuses with a specific reason, so an unmatched result fails loudly instead
 * of dropping a jar the server cannot load. The note under the search box says
 * as much rather than letting it look like a filter that quietly broke.
 */

const SEARCH_DEBOUNCE_MS = 350

/** Both project types a server can load; anything else Modrinth indexes is noise here. */
const FACETS = JSON.stringify([['project_type:mod', 'project_type:plugin']])

interface ServerMod {
  fileName: string
  sizeBytes?: number
  projectId?: string
  title?: string
  versionNumber?: string
  iconUrl?: string
  source?: string
}

interface Hit {
  projectId: string
  title: string
  iconUrl?: string
  downloads: number
}

/** Raw Modrinth search row — every field is optional on the wire. */
interface ModrinthHit {
  project_id?: string
  slug?: string
  title?: string
  icon_url?: string | null
  downloads?: number
}

const CLIP: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap'
}

const SUB: React.CSSProperties = { ...CLIP, fontSize: 'var(--fs-small)' }

function msg(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong.'
}

function label(mod: ServerMod): string {
  return mod.title || mod.fileName
}

function size(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return ''
  return bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/**
 * The relay stops waiting after 22s; a large mod with dependencies routinely
 * takes longer. Reporting that as a failure would be a lie — the download is
 * still running on the host.
 */
function stillWorking(text: string): boolean {
  return /no answer from the machine/i.test(text)
}

async function searchModrinth(query: string): Promise<Hit[]> {
  const url =
    `https://api.modrinth.com/v2/search?limit=12&index=relevance` +
    `&query=${encodeURIComponent(query)}&facets=${encodeURIComponent(FACETS)}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Modrinth search failed (HTTP ${res.status}).`)
  const body = (await res.json()) as { hits?: ModrinthHit[] }
  return (body.hits ?? [])
    .filter((h) => h.project_id || h.slug)
    .map((h) => ({
      projectId: String(h.project_id ?? h.slug),
      title: h.title || String(h.slug ?? 'Unnamed'),
      iconUrl: h.icon_url ?? undefined,
      downloads: Number(h.downloads ?? 0)
    }))
}

function Icon({ url }: { url?: string }): React.JSX.Element {
  const [broken, setBroken] = useState(false)
  if (!url || broken) {
    return <span className="avatar" aria-hidden />
  }
  return (
    <img
      src={url}
      alt=""
      loading="lazy"
      onError={() => setBroken(true)}
      style={{ width: 26, height: 26, flex: 'none', borderRadius: 'var(--radius-xs)', objectFit: 'cover' }}
    />
  )
}

/**
 * Destructive actions confirm in place rather than through window.confirm: the
 * dialog cannot name the file in the panel's own voice, and on a phone it is
 * one mis-tap away from being dismissed without anyone reading it.
 */
function Confirm({
  text,
  cta,
  busy,
  onConfirm,
  onCancel
}: {
  text: string
  cta: string
  busy: boolean
  onConfirm: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="formnote stack" role="alert" style={{ gap: 10 }}>
      <span>{text}</span>
      <div className="row">
        <Button size="sm" variant="danger" disabled={busy} onClick={onConfirm}>
          {busy ? 'Removing…' : cta}
        </Button>
        <Button size="sm" variant="ghost" disabled={busy} onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  )
}

export function Mods({ row, ask }: TabProps): React.JSX.Element {
  const [installed, setInstalled] = useState<ServerMod[]>([])
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')

  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<Hit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [searchErr, setSearchErr] = useState('')

  const [byId, setById] = useState('')
  const [busyId, setBusyId] = useState('')
  const [confirming, setConfirming] = useState<ServerMod | null>(null)
  const [removing, setRemoving] = useState(false)
  const [actionErr, setActionErr] = useState('')
  const [notice, setNotice] = useState('')

  // The shell is free to hand this tab a fresh `ask` on every render. Reading it
  // from a ref keeps that out of the effect dependencies, where it would restart
  // the load in a loop.
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  })

  const load = useCallback(async (): Promise<void> => {
    setLoading(true)
    setLoadErr('')
    try {
      const list = await askRef.current<ServerMod[]>('mods')
      setInstalled(Array.isArray(list) ? list : [])
    } catch (e) {
      setLoadErr(msg(e))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load, row.server_id])

  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setHits(null)
      setSearchErr('')
      setSearching(false)
      return
    }
    let alive = true
    setSearching(true)
    setSearchErr('')
    const timer = setTimeout(() => {
      void searchModrinth(q)
        .then((found) => {
          if (alive) setHits(found)
        })
        .catch((e: unknown) => {
          if (!alive) return
          setHits(null)
          setSearchErr(msg(e))
        })
        .finally(() => {
          if (alive) setSearching(false)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [query])

  async function install(projectId: string, name: string): Promise<void> {
    setBusyId(projectId)
    setActionErr('')
    setNotice('')
    try {
      await askRef.current('installMod', { projectId })
      setNotice(`${name} installed${row.state === 'running' ? ' — restart the server to apply' : ''}.`)
      setById('')
      await load()
    } catch (e) {
      const text = msg(e)
      setActionErr(
        stillWorking(text)
          ? `${name} is taking longer than the panel waits for an answer. It may still be installing — refresh the list in a moment to see.`
          : text
      )
    } finally {
      setBusyId('')
    }
  }

  async function remove(mod: ServerMod): Promise<void> {
    setRemoving(true)
    setActionErr('')
    setNotice('')
    try {
      // the host answers with the folder as it now stands, so there is no second
      // round trip just to find out what survived
      const list = await askRef.current<ServerMod[]>('removeMod', { fileName: mod.fileName })
      setInstalled(Array.isArray(list) ? list : [])
      setConfirming(null)
      setNotice(`${label(mod)} removed${row.state === 'running' ? ' — restart the server to apply' : ''}.`)
    } catch (e) {
      setActionErr(msg(e))
    } finally {
      setRemoving(false)
    }
  }

  const installedIds = new Set(installed.map((m) => m.projectId).filter(Boolean))

  return (
    <div className="stack">
      {notice && <p className="formnote">{notice}</p>}
      {actionErr && (
        <p className="formerr" role="alert">
          {actionErr}
        </p>
      )}

      <section className="surface pad stack">
        <div className="row">
          <h2 style={CLIP}>Installed{!loading && !loadErr ? ` (${installed.length})` : ''}</h2>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
            {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        {loading && (
          <>
            <Skeleton height={40} />
            <Skeleton height={40} />
            <Skeleton height={40} />
          </>
        )}

        {!loading && loadErr && (
          <p className="formerr" role="alert">
            {loadErr}
          </p>
        )}

        {!loading && !loadErr && installed.length === 0 && (
          <p className="dim">Nothing installed yet — search below to add something.</p>
        )}

        {!loading &&
          !loadErr &&
          installed.map((mod) =>
            confirming?.fileName === mod.fileName ? (
              <Confirm
                key={mod.fileName}
                text={`Remove ${label(mod)} (${mod.fileName})? The jar is deleted from the server.`}
                cta="Remove"
                busy={removing}
                onConfirm={() => void remove(mod)}
                onCancel={() => setConfirming(null)}
              />
            ) : (
              <div className="row" key={mod.fileName}>
                <Icon url={mod.iconUrl} />
                <div style={{ ...CLIP, display: 'flex', flexDirection: 'column' }}>
                  <span style={CLIP}>{label(mod)}</span>
                  <span className="dim" style={SUB}>
                    {[mod.versionNumber || mod.fileName, size(mod.sizeBytes)].filter(Boolean).join(' · ')}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant="danger"
                  disabled={removing}
                  onClick={() => setConfirming(mod)}
                  aria-label={`Remove ${label(mod)}`}
                >
                  Remove
                </Button>
              </div>
            )
          )}
      </section>

      <section className="surface pad stack">
        <h2>Add mods and plugins</h2>

        <div className="field">
          <label htmlFor="mod-search">Search Modrinth</label>
          <input
            id="mod-search"
            className="input"
            value={query}
            autoComplete="off"
            placeholder="Search mods and plugins…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {searching && <Skeleton height={40} />}

        {!searching && searchErr && (
          <p className="formerr" role="alert">
            {searchErr}
          </p>
        )}

        {!searching && !searchErr && hits === null && <p className="dim">Type to search.</p>}

        {!searching && !searchErr && hits?.length === 0 && <p className="dim">Nothing matched that.</p>}

        {!searching &&
          !searchErr &&
          hits?.map((hit) => (
            <div className="row" key={hit.projectId}>
              <Icon url={hit.iconUrl} />
              <div style={{ ...CLIP, display: 'flex', flexDirection: 'column' }}>
                <span style={CLIP}>{hit.title}</span>
                <span className="dim" style={SUB}>
                  {hit.downloads.toLocaleString()} downloads
                </span>
              </div>
              {installedIds.has(hit.projectId) ? (
                <span className="dim" style={{ fontSize: 'var(--fs-small)', flex: 'none' }}>
                  Installed
                </span>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busyId !== ''}
                  onClick={() => void install(hit.projectId, hit.title)}
                  aria-label={`Install ${hit.title}`}
                >
                  {busyId === hit.projectId ? 'Installing…' : 'Install'}
                </Button>
              )}
            </div>
          ))}

        <div className="field">
          <label htmlFor="mod-id">Or install by Modrinth id or slug</label>
          <div className="row">
            <input
              id="mod-id"
              className="input"
              value={byId}
              autoComplete="off"
              spellCheck={false}
              placeholder="sodium"
              onChange={(e) => setById(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && byId.trim() && !busyId) void install(byId.trim(), byId.trim())
              }}
            />
            <Button
              variant="primary"
              disabled={!byId.trim() || busyId !== ''}
              onClick={() => void install(byId.trim(), byId.trim())}
            >
              {busyId === byId.trim() ? 'Installing…' : 'Install'}
            </Button>
          </div>
        </div>

        <p className="dim" style={{ fontSize: 'var(--fs-small)' }}>
          Results are not narrowed to this server&rsquo;s loader or Minecraft version. The host checks both
          before it downloads anything and will say which build is missing if there is no match. Required
          dependencies come along automatically.
        </p>
      </section>
    </div>
  )
}
