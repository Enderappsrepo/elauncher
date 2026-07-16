import { useCallback, useEffect, useState } from 'react'
import type { ContentKind, Instance, InstalledPack, ModSearchHit, ModSource } from '@shared/types'
import { useToast } from '../toast'
import { formatBytes, formatCount } from '../fmt'
import { IconAlert, IconCheck, IconDownload, IconExternal, IconLayers, IconSearch, IconSparkles, IconTrash } from '../icons'

const PAGE_SIZE = 12

/** Modrinth slugs of the shader-loader mod per loader. */
const SHADER_LOADERS: Record<string, { slug: string; name: string }> = {
  fabric: { slug: 'iris', name: 'Iris Shaders' },
  forge: { slug: 'oculus', name: 'Oculus' },
  neoforge: { slug: 'iris', name: 'Iris Shaders' }
}

interface Props {
  instance: Instance
  kind: ContentKind
}

/** Shader packs / resource packs tab: installed list + Modrinth/CurseForge search. */
export default function ContentTab({ instance, kind }: Props): React.JSX.Element {
  const toast = useToast()
  const label = kind === 'shader' ? 'shader pack' : 'resource pack'

  const [installed, setInstalled] = useState<InstalledPack[] | null>(null)
  const [source, setSource] = useState<ModSource>('modrinth')
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<ModSearchHit[] | null>(null)
  const [totalHits, setTotalHits] = useState(0)
  const [offset, setOffset] = useState(0)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<Set<string>>(new Set())
  const [hasShaderLoader, setHasShaderLoader] = useState(true)
  const [installingLoader, setInstallingLoader] = useState(false)

  const refresh = useCallback(() => {
    window.elauncher.content.list(instance.id, kind).then(setInstalled).catch(console.error)
  }, [instance.id, kind])

  useEffect(() => refresh(), [refresh])

  // shaders need Iris/Oculus; check the mods folder for one
  useEffect(() => {
    if (kind !== 'shader' || instance.loader === 'vanilla') return
    window.elauncher.mods
      .listInstalled(instance.id)
      .then((mods) => {
        const found = mods.some((m) => /iris|oculus/i.test(m.title ?? m.displayName))
        setHasShaderLoader(found)
      })
      .catch(() => {})
  }, [instance.id, kind])

  const search = useCallback(
    async (newOffset: number): Promise<void> => {
      setLoading(true)
      setError(null)
      try {
        const result = await window.elauncher.mods.search({
          query,
          mcVersion: instance.minecraftVersion,
          loader: instance.loader,
          source,
          offset: newOffset,
          limit: PAGE_SIZE,
          projectType: kind === 'shader' ? 'shader' : 'resourcepack'
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
    [instance.id, instance.minecraftVersion, instance.loader, query, source, kind]
  )

  useEffect(() => {
    const t = setTimeout(() => void search(0), 300)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, source, instance.id, kind])

  const install = async (hit: ModSearchHit): Promise<void> => {
    setInstalling((s) => new Set(s).add(hit.projectId))
    const result = await window.elauncher.content.install(
      { instanceId: instance.id, source: hit.source, projectId: hit.projectId },
      kind
    )
    if (result.ok) toast.success(`Installed ${hit.title}`)
    else toast.error(result.error ?? 'Install failed')
    setInstalling((s) => {
      const next = new Set(s)
      next.delete(hit.projectId)
      return next
    })
    refresh()
  }

  const installShaderLoader = async (): Promise<void> => {
    const loader = SHADER_LOADERS[instance.loader]
    if (!loader) return
    setInstallingLoader(true)
    const result = await window.elauncher.mods.install({
      instanceId: instance.id,
      source: 'modrinth',
      projectId: loader.slug
    })
    if (result.ok) {
      toast.success(`Installed ${loader.name}`)
      setHasShaderLoader(true)
    } else {
      toast.error(result.error ?? 'Install failed')
    }
    setInstallingLoader(false)
  }

  const installedProjects = new Set((installed ?? []).filter((p) => p.projectId).map((p) => p.projectId!))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {kind === 'shader' && instance.loader === 'vanilla' && (
        <div className="pill-note">
          <IconAlert size={15} />
          Shaders need a mod loader (Fabric, Forge or NeoForge) plus Iris or Oculus. This instance is vanilla.
        </div>
      )}
      {kind === 'shader' && instance.loader !== 'vanilla' && !hasShaderLoader && (
        <div className="pill-note" style={{ justifyContent: 'space-between', display: 'flex' }}>
          <span className="row" style={{ gap: 7 }}>
            <IconAlert size={15} />
            No shader loader detected — shader packs need {SHADER_LOADERS[instance.loader]?.name} to work.
          </span>
          <button className="primary" style={{ padding: '5px 12px' }} disabled={installingLoader} onClick={() => void installShaderLoader()}>
            {installingLoader ? 'Installing…' : `Install ${SHADER_LOADERS[instance.loader]?.name}`}
          </button>
        </div>
      )}

      {/* installed packs */}
      <div>
        <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
          <div className="muted small">
            {installed === null
              ? 'Loading…'
              : `${installed.length} ${label}${installed.length === 1 ? '' : 's'} installed`}
          </div>
        </div>
        {installed !== null && installed.length > 0 && (
          <div className="mod-list">
            {installed.map((pack) => (
              <div className="mod-row" key={pack.fileName} style={{ opacity: pack.enabled ? 1 : 0.55 }}>
                {pack.iconUrl ? (
                  <img className="mod-icon" src={pack.iconUrl} alt="" loading="lazy" />
                ) : (
                  <div className="mod-icon-placeholder">
                    {kind === 'shader' ? <IconSparkles size={20} /> : <IconLayers size={20} />}
                  </div>
                )}
                <div className="info">
                  <h4>{pack.title ?? pack.displayName}</h4>
                  <div className="meta">
                    {pack.versionNumber && <span>{pack.versionNumber}</span>}
                    {pack.sizeBytes > 0 && <span>{formatBytes(pack.sizeBytes)}</span>}
                    {pack.source && <span>{pack.source}</span>}
                    {!pack.enabled && <span style={{ color: 'var(--yellow)' }}>disabled</span>}
                  </div>
                </div>
                <span className="switch green" title={pack.enabled ? 'Disable' : 'Enable'} style={{ marginTop: 0 }}>
                  <input
                    type="checkbox"
                    checked={pack.enabled}
                    onChange={() =>
                      void window.elauncher.content.toggle(instance.id, kind, pack.fileName).then(setInstalled)
                    }
                  />
                  <span className="knob" />
                </span>
                <button
                  className="icon-btn"
                  title="Remove"
                  onClick={() =>
                    void window.elauncher.content.remove(instance.id, kind, pack.fileName).then(setInstalled)
                  }
                >
                  <IconTrash size={15} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* browse & install */}
      <div>
        <div className="row" style={{ marginBottom: 12, justifyContent: 'space-between' }}>
          <div className="search-wrap" style={{ flex: 1, maxWidth: 420 }}>
            <IconSearch size={15} />
            <input
              placeholder={`Search ${label}s for ${instance.minecraftVersion}…`}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
          <div className="segmented">
            <button className={source === 'modrinth' ? 'active' : ''} onClick={() => setSource('modrinth')}>
              Modrinth
            </button>
            <button className={source === 'curseforge' ? 'active' : ''} onClick={() => setSource('curseforge')}>
              CurseForge
            </button>
          </div>
        </div>

        {error && (
          <div className="error-banner">
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}

        {loading || hits === null ? (
          <div className="mod-list">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 76 }} />
            ))}
          </div>
        ) : (
          <div className="mod-list">
            {hits.map((hit) => {
              const isInstalled = installedProjects.has(hit.projectId)
              const isInstalling = installing.has(hit.projectId)
              return (
                <div className="mod-row" key={`${hit.source}:${hit.projectId}`}>
                  {hit.iconUrl ? (
                    <img className="mod-icon" src={hit.iconUrl} alt="" loading="lazy" />
                  ) : (
                    <div className="mod-icon-placeholder">
                      {kind === 'shader' ? <IconSparkles size={20} /> : <IconLayers size={20} />}
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
                  <button className="icon-btn" title="Open project page" onClick={() => window.open(hit.pageUrl, '_blank')}>
                    <IconExternal size={15} />
                  </button>
                  <button
                    className={isInstalled ? 'ghost' : 'primary'}
                    style={{ minWidth: 104 }}
                    disabled={isInstalled || isInstalling}
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
                        <IconDownload size={14} /> Install
                      </>
                    )}
                  </button>
                </div>
              )
            })}
            {hits.length === 0 && !error && (
              <div className="empty-state" style={{ padding: '40px 20px' }}>
                <h2>No results</h2>
                <p>No {label}s found for this search on {instance.minecraftVersion}.</p>
              </div>
            )}
          </div>
        )}

        {totalHits > PAGE_SIZE && hits !== null && (
          <div className="row" style={{ justifyContent: 'center', marginTop: 16 }}>
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
    </div>
  )
}
