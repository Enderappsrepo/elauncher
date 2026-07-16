import { useCallback, useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { ContentKind, ModSearchHit, ModSource } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { formatCount } from '../fmt'
import { IconAlert, IconBox, IconCheck, IconDownload, IconExternal, IconGrid, IconSearch } from '../icons'
import Select from '../components/Select'

const PAGE_SIZE = 20

type ProjType = 'mod' | 'modpack' | 'shader' | 'resourcepack'

const TYPES: { id: ProjType; label: string }[] = [
  { id: 'mod', label: 'Mods' },
  { id: 'modpack', label: 'Modpacks' },
  { id: 'shader', label: 'Shaders' },
  { id: 'resourcepack', label: 'Resource Packs' }
]

const TYPE_NOUN: Record<ProjType, string> = {
  mod: 'mods',
  modpack: 'modpacks',
  shader: 'shaders',
  resourcepack: 'resource packs'
}

export default function ModBrowserPage(): React.JSX.Element {
  const { instances, refreshInstances, packTasks } = useAppState()
  const toast = useToast()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const instanceId = searchParams.get('instance') ?? instances[0]?.id ?? ''
  const instance = instances.find((i) => i.id === instanceId) ?? instances[0]
  const noInstances = instances.length === 0

  const [source, setSource] = useState<ModSource>('modrinth')
  const [rawType, setRawType] = useState<ProjType>('mod')
  // with no instances yet, the only thing you can install is a whole modpack
  const type: ProjType = noInstances ? 'modpack' : rawType
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ModSearchHit[] | null>(null)
  const [totalHits, setTotalHits] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [installed, setInstalled] = useState<Set<string>>(new Set())

  const needsInstance = type !== 'modpack'
  const packTask = packTasks['import']

  const refreshInstalled = useCallback(() => {
    if (!instance || type !== 'mod') {
      setInstalled(new Set())
      return
    }
    window.elauncher.mods
      .listInstalled(instance.id)
      .then((mods) => setInstalled(new Set(mods.filter((m) => m.projectId).map((m) => m.projectId!))))
      .catch(console.error)
  }, [instance?.id, type])

  useEffect(() => refreshInstalled(), [refreshInstalled])

  const search = useCallback(
    async (newOffset: number): Promise<void> => {
      if (needsInstance && !instance) return
      setLoading(true)
      setError(null)
      try {
        const result = await window.elauncher.mods.search({
          query,
          // modpacks bring their own version/loader, so don't constrain them
          mcVersion: type === 'modpack' ? undefined : instance?.minecraftVersion,
          loader: type === 'mod' ? instance?.loader : undefined,
          source,
          projectType: type,
          offset: newOffset,
          limit: PAGE_SIZE
        })
        setHits(result.hits)
        setTotalHits(result.totalHits)
        setOffset(newOffset)
      } catch (e) {
        setHits([])
        setError(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [instance?.id, instance?.minecraftVersion, instance?.loader, query, source, type, needsInstance]
  )

  useEffect(() => {
    const t = setTimeout(() => void search(0), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, source, type, instance?.id])

  const markInstalling = (id: string, on: boolean): void =>
    setInstalling((s) => {
      const next = new Set(s)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const install = async (hit: ModSearchHit): Promise<void> => {
    markInstalling(hit.projectId, true)
    try {
      if (type === 'modpack') {
        toast.success(`Installing "${hit.title}" — this can take a few minutes`)
        const inst = await window.elauncher.packs.installModpack(hit.source, hit.projectId)
        await refreshInstances()
        toast.success(`Installed "${hit.title}"`)
        navigate(`/instances/${inst.id}`)
      } else if (type === 'mod') {
        const result = await window.elauncher.mods.install({
          instanceId: instance!.id,
          source: hit.source,
          projectId: hit.projectId
        })
        if (result.ok) toast.success(`Installed ${hit.title}`)
        else toast.error(result.error ?? 'Install failed')
        refreshInstalled()
      } else {
        const result = await window.elauncher.content.install(
          { instanceId: instance!.id, source: hit.source, projectId: hit.projectId },
          type as ContentKind
        )
        if (result.ok) toast.success(`Installed ${hit.title}`)
        else toast.error(result.error ?? 'Install failed')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      markInstalling(hit.projectId, false)
    }
  }

  const vanillaBlocked = type === 'mod' && instance?.loader === 'vanilla'

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Browse</h1>
          <p className="muted small" style={{ marginTop: 2 }}>
            {type === 'modpack'
              ? 'Install a whole modpack from Modrinth or CurseForge as a new instance.'
              : 'Search Modrinth and CurseForge, filtered for the selected instance.'}
          </p>
        </div>
        <div className="row">
          {needsInstance && !noInstances && (
            <Select
              value={instance?.id ?? ''}
              onChange={(id) => setSearchParams({ instance: id })}
              style={{ width: 240 }}
              options={instances.map((i) => ({
                value: i.id,
                label: `${i.name} (${i.minecraftVersion} ${i.loader})`
              }))}
            />
          )}
          <div className="segmented">
            <button className={source === 'modrinth' ? 'active' : ''} onClick={() => setSource('modrinth')}>
              Modrinth
            </button>
            <button className={source === 'curseforge' ? 'active' : ''} onClick={() => setSource('curseforge')}>
              CurseForge
            </button>
          </div>
        </div>
      </div>

      <div className="segmented type-seg" style={{ marginBottom: 16 }}>
        {TYPES.map((t) => (
          <button
            key={t.id}
            className={type === t.id ? 'active' : ''}
            disabled={noInstances && t.id !== 'modpack'}
            title={noInstances && t.id !== 'modpack' ? 'Create an instance first, or install a modpack below' : undefined}
            onClick={() => setRawType(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {noInstances && (
        <div className="pill-note" style={{ marginBottom: 16 }}>
          <IconGrid size={15} />
          You have no instances yet — install a modpack to create your first one, or make an empty instance from the
          Instances page.
        </div>
      )}

      {vanillaBlocked && (
        <div className="error-banner">
          <IconAlert size={16} />
          <span>
            <b>{instance?.name}</b> is a vanilla instance — mods require Fabric, Forge or NeoForge. Switch to Modpacks,
            or pick a modded instance above.
          </span>
        </div>
      )}

      <div className="search-wrap" style={{ marginBottom: 18 }}>
        <IconSearch size={16} />
        <input
          placeholder={`Search ${source === 'modrinth' ? 'Modrinth' : 'CurseForge'} ${TYPE_NOUN[type]}…`}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {type === 'modpack' && packTask && (
        <div className="card" style={{ marginBottom: 16, padding: 14 }}>
          <div className="row small muted" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
            <span>{packTask.phase}</span>
            {packTask.progress >= 0 && <span>{Math.round(packTask.progress * 100)}%</span>}
          </div>
          <div className="progress-track">
            <div
              className={`progress-fill${packTask.progress < 0 ? ' indeterminate' : ''}`}
              style={{ width: packTask.progress >= 0 ? `${Math.round(packTask.progress * 100)}%` : undefined }}
            />
          </div>
        </div>
      )}

      {error && (
        <div className="error-banner">
          <IconAlert size={16} />
          <span>{error}</span>
        </div>
      )}

      {loading || hits === null ? (
        <div className="mod-list">
          {[0, 1, 2, 3, 4].map((i) => (
            <div key={i} className="skeleton" style={{ height: 76 }} />
          ))}
        </div>
      ) : (
        <div className="mod-list">
          {hits.map((hit) => {
            const isInstalled = type === 'mod' && installed.has(hit.projectId)
            const isInstalling = installing.has(hit.projectId)
            return (
              <div className="mod-row" key={`${hit.source}:${hit.projectId}`}>
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
                      <IconDownload size={11} /> {formatCount(hit.downloads)} downloads
                    </span>
                  </div>
                </div>
                <button
                  className="icon-btn"
                  title="Open project page"
                  onClick={() => window.open(hit.pageUrl, '_blank')}
                >
                  <IconExternal size={15} />
                </button>
                <button
                  className={isInstalled ? 'ghost' : 'primary'}
                  style={{ minWidth: 118 }}
                  disabled={isInstalled || isInstalling || vanillaBlocked}
                  onClick={() => void install(hit)}
                >
                  {isInstalled ? (
                    <>
                      <IconCheck size={14} /> Installed
                    </>
                  ) : isInstalling ? (
                    'Installing…'
                  ) : (
                    <>
                      <IconDownload size={14} /> {type === 'modpack' ? 'Install pack' : 'Install'}
                    </>
                  )}
                </button>
              </div>
            )
          })}
          {hits.length === 0 && !error && (
            <div className="empty-state">
              <h2>No results</h2>
              <p>No {TYPE_NOUN[type]} found for this search.</p>
            </div>
          )}
        </div>
      )}

      {totalHits > PAGE_SIZE && hits !== null && (
        <div className="row" style={{ justifyContent: 'center', marginTop: 20 }}>
          <button className="ghost" disabled={offset === 0 || loading} onClick={() => void search(offset - PAGE_SIZE)}>
            Previous
          </button>
          <span className="muted small">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, totalHits)} of {formatCount(totalHits)}
          </span>
          <button
            className="ghost"
            disabled={offset + PAGE_SIZE >= totalHits || loading}
            onClick={() => void search(offset + PAGE_SIZE)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
