import { useCallback, useEffect, useRef, useState } from 'react'
import { Blocks, PackageX, RefreshCw, SearchX } from 'lucide-react'
import { toast } from 'sonner'
import { Button, EmptyState, Skeleton, Spinner } from '@web/ui'
import { AnimatePresence, EASE_OUT, EASE_SPRING, motion } from '@web/ui/motion'
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

/** Rows hold 44px even around a small button, so a thumb never has to aim. */
const ROW: React.CSSProperties = { minHeight: 44 }

/** installMod holds the line for up to 40 seconds; the copy owns that. */
const SLOW_COPY = 'Installing — big mods take a minute…'

/* One motion vocabulary for every list here: rows arrive with a small capped
 * stagger, and leave (only the installed list loses rows) by folding closed. */
const rowIn = (i: number): React.ComponentProps<typeof motion.div>['animate'] => ({
  opacity: 1,
  y: 0,
  transition: { duration: 0.32, ease: EASE_SPRING, delay: Math.min(i, 6) * 0.04 }
})

const ROW_OUT = {
  opacity: 0,
  height: 0,
  overflow: 'hidden',
  transition: { duration: 0.24, ease: EASE_OUT }
} as const

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

/* The loading list is the list with the ink not yet dry — icon square, a
 * name-shaped bar, a button-shaped block, at the heights the real rows use.
 * Bars vary in width so the screen has the texture of content, not of stripes. */
function GhostRows({ rows }: { rows: number }): React.JSX.Element {
  return (
    <div className="stack" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div className="row" style={ROW} key={i}>
          <Skeleton height={26} width={26} />
          <div className="stack" style={{ flex: 1, gap: 6 }}>
            <Skeleton height={12} width={`${62 - (i % 3) * 14}%`} />
            <Skeleton height={9} width={110} />
          </div>
          <Skeleton height={34} width={78} />
        </div>
      ))}
    </div>
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

  const searchInput = useRef<HTMLInputElement>(null)

  // The shell is free to hand this tab a fresh `ask` on every render. Reading it
  // from a ref keeps that out of the effect dependencies, where it would restart
  // the load in a loop.
  const askRef = useRef(ask)
  useEffect(() => {
    askRef.current = ask
  })

  // `keep` refreshes behind the list that is already up — after an install the
  // panel knows a row is coming, and blanking the rest to skeletons to prove it
  // reads as a crash.
  const load = useCallback(async (keep = false): Promise<void> => {
    if (!keep) setLoading(true)
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
    try {
      await askRef.current('installMod', { projectId })
      // a toast, because forty seconds is long enough to have wandered off
      toast.success(
        `${name} installed.`,
        row.state === 'running' ? { description: 'Restart the server to load it.' } : undefined
      )
      setById('')
      await load(true)
    } catch (e) {
      const text = msg(e)
      if (stillWorking(text)) {
        // not a failure — the host is still downloading, so it must not sound
        // like one
        toast(`${name} is still installing`, {
          description: 'It outlasted the panel’s patience, not the host’s — refresh the list in a moment.'
        })
      } else {
        toast.error(text)
      }
    } finally {
      setBusyId('')
    }
  }

  async function remove(mod: ServerMod): Promise<void> {
    setRemoving(true)
    setActionErr('')
    try {
      // the host answers with the folder as it now stands, so there is no second
      // round trip just to find out what survived
      const list = await askRef.current<ServerMod[]>('removeMod', { fileName: mod.fileName })
      setInstalled(Array.isArray(list) ? list : [])
      setConfirming(null)
      toast.success(
        `${label(mod)} removed.`,
        row.state === 'running' ? { description: 'Restart the server to let it go.' } : undefined
      )
    } catch (e) {
      // inline, not toasted: whoever is removing is standing at the confirm
      setActionErr(msg(e))
    } finally {
      setRemoving(false)
    }
  }

  const installedIds = new Set(installed.map((m) => m.projectId).filter(Boolean))

  return (
    <div className="stack">
      {actionErr && (
        <p className="formerr" role="alert">
          {actionErr}
        </p>
      )}

      <section className="surface pad stack">
        <div className="row">
          <h2 style={CLIP}>Installed{!loading && !loadErr ? ` (${installed.length})` : ''}</h2>
          <Button size="sm" variant="ghost" disabled={loading} onClick={() => void load()}>
            <RefreshCw size={14} aria-hidden /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </div>

        {loading && <GhostRows rows={3} />}

        {!loading && loadErr && (
          <EmptyState
            icon={<PackageX size={18} />}
            title="Couldn't load the mod list"
            action={
              <Button size="sm" onClick={() => void load()}>
                Try again
              </Button>
            }
          >
            {loadErr}
          </EmptyState>
        )}

        {!loading && !loadErr && installed.length === 0 && (
          <EmptyState
            icon={<Blocks size={18} />}
            title="Nothing installed yet"
            action={
              <Button variant="primary" onClick={() => searchInput.current?.focus()}>
                Search Modrinth
              </Button>
            }
          >
            Mods and plugins land in this list the moment they install — a restart loads them.
          </EmptyState>
        )}

        {!loading && !loadErr && (
          <AnimatePresence>
            {installed.map((mod, i) => (
              <motion.div
                key={mod.fileName}
                initial={{ opacity: 0, y: 10 }}
                animate={rowIn(i)}
                exit={ROW_OUT}
              >
                {confirming?.fileName === mod.fileName ? (
                  <Confirm
                    text={`Remove ${label(mod)} (${mod.fileName})? The jar is deleted from the server.`}
                    cta="Remove"
                    busy={removing}
                    onConfirm={() => void remove(mod)}
                    onCancel={() => setConfirming(null)}
                  />
                ) : (
                  <div className="row" style={ROW}>
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
                )}
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </section>

      <section className="surface pad stack">
        <h2>Add mods and plugins</h2>

        <div className="field">
          <label htmlFor="mod-search">Search Modrinth</label>
          <input
            id="mod-search"
            ref={searchInput}
            className="input"
            value={query}
            autoComplete="off"
            enterKeyHint="search"
            placeholder="Search mods and plugins…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>

        {searching && <GhostRows rows={4} />}

        {!searching && searchErr && (
          <p className="formerr" role="alert">
            {searchErr}
          </p>
        )}

        {!searching && !searchErr && hits === null && <p className="dim">Type to search.</p>}

        {/* an empty search is Modrinth's silence, not an empty server — it must
          * never wear the same face as "nothing installed" */}
        {!searching && !searchErr && hits?.length === 0 && (
          <EmptyState
            icon={<SearchX size={18} />}
            title={`No matches for “${query.trim()}”`}
            action={
              <Button variant="ghost" onClick={() => setQuery('')}>
                Clear search
              </Button>
            }
          >
            Modrinth indexes mods and plugins by project name — fewer or shorter words find more.
          </EmptyState>
        )}

        {!searching &&
          !searchErr &&
          hits?.map((hit, i) => (
            <motion.div
              className="row"
              style={ROW}
              key={hit.projectId}
              initial={{ opacity: 0, y: 10 }}
              animate={rowIn(i)}
            >
              <Icon url={hit.iconUrl} />
              <div style={{ ...CLIP, display: 'flex', flexDirection: 'column' }}>
                <span style={CLIP}>{hit.title}</span>
                {busyId === hit.projectId ? (
                  <span style={{ ...SUB, color: 'var(--yellow)' }}>{SLOW_COPY}</span>
                ) : (
                  <span className="dim" style={SUB}>
                    {hit.downloads.toLocaleString()} downloads
                  </span>
                )}
              </div>
              {installedIds.has(hit.projectId) ? (
                <span className="dim" style={{ fontSize: 'var(--fs-small)', flex: 'none' }}>
                  Installed
                </span>
              ) : busyId === hit.projectId ? (
                <Button size="sm" variant="primary" disabled aria-label={`Installing ${hit.title}`}>
                  <Spinner /> Installing…
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busyId !== ''}
                  onClick={() => void install(hit.projectId, hit.title)}
                  aria-label={`Install ${hit.title}`}
                >
                  Install
                </Button>
              )}
            </motion.div>
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
              {busyId !== '' && busyId === byId.trim() ? (
                <>
                  <Spinner /> Installing…
                </>
              ) : (
                'Install'
              )}
            </Button>
          </div>
          {busyId !== '' && busyId === byId.trim() && (
            <p style={{ color: 'var(--yellow)', fontSize: 'var(--fs-small)' }}>{SLOW_COPY}</p>
          )}
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
