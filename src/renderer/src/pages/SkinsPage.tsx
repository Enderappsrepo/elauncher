import { useCallback, useEffect, useRef, useState } from 'react'
import { IdleAnimation, SkinViewer, WalkingAnimation } from 'skinview3d'
import type { SavedSkin, SkinInfo, SkinSearchResult } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { timeAgo } from '../fmt'
import { IconCheck, IconDownload, IconRefresh, IconSearch, IconTrash, IconUpload, IconUser } from '../icons'

/** A skin currently loaded in the 3D viewer — from the library (savedId) or browsed (url). */
interface Preview {
  name: string
  dataUrl: string
  variant: 'classic' | 'slim'
  savedId?: string
  url?: string
}

/** Recognizable community skins to browse out of the box. */
const FEATURED = ['Technoblade', 'Grian', 'jeb_', 'Dream', 'TommyInnit', 'Philza', 'CaptainSparklez', 'Skeppy']
// fetched once per app session so revisiting the page is instant
let featuredCache: SkinSearchResult[] | null = null

/** Draws the face (plus hat layer) from a 64px skin texture, pixelated. */
function SkinFace({ dataUrl, size = 72 }: { dataUrl: string; size?: number }): React.JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      ctx.imageSmoothingEnabled = false
      ctx.clearRect(0, 0, size, size)
      ctx.drawImage(img, 8, 8, 8, 8, 0, 0, size, size)
      ctx.drawImage(img, 40, 8, 8, 8, 0, 0, size, size)
    }
    img.src = dataUrl
  }, [dataUrl, size])

  return <canvas ref={canvasRef} className="skin-face" width={size} height={size} />
}

/** A browsed skin (search result or featured) with preview / use / save actions. */
function BrowseCard({
  skin,
  applying,
  saving,
  onPreview,
  onUse,
  onSave
}: {
  skin: SkinSearchResult
  applying: boolean
  saving: boolean
  onPreview: () => void
  onUse: () => void
  onSave: () => void
}): React.JSX.Element {
  return (
    <div className="skin-card">
      <button style={{ background: 'none', padding: 0 }} title="Preview in 3D" onClick={onPreview}>
        <SkinFace dataUrl={skin.dataUrl} />
      </button>
      <div style={{ textAlign: 'center', minWidth: 0, width: '100%' }}>
        <div className="skin-name">{skin.username}</div>
        <div className="small faint" style={{ textTransform: 'capitalize' }}>
          {skin.variant} model
        </div>
      </div>
      <div className="skin-actions">
        <button className="primary" style={{ padding: '6px 12px', fontSize: 12 }} disabled={applying} onClick={onUse}>
          {applying ? (
            'Applying…'
          ) : (
            <>
              <IconCheck size={13} /> Use
            </>
          )}
        </button>
        <button className="icon-btn" title="Save to library" disabled={saving} onClick={onSave}>
          <IconDownload size={14} />
        </button>
      </div>
    </div>
  )
}

export default function SkinsPage(): React.JSX.Element {
  const { accounts } = useAppState()
  const toast = useToast()
  const active = accounts.accounts.find((a) => a.uuid === accounts.activeUuid)

  const canvasRef = useRef<HTMLCanvasElement>(null)
  const viewerRef = useRef<SkinViewer | null>(null)
  const [info, setInfo] = useState<SkinInfo | null>(null)
  const [infoError, setInfoError] = useState<string | null>(null)
  const [library, setLibrary] = useState<SavedSkin[]>([])
  const [preview, setPreview] = useState<Preview | null>(null)
  const [applying, setApplying] = useState<string | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [walking, setWalking] = useState(true)
  const [busy, setBusy] = useState(false)

  // skin browser
  const [finderQuery, setFinderQuery] = useState('')
  const [finding, setFinding] = useState(false)
  const [found, setFound] = useState<SkinSearchResult | null>(null)
  const [finderError, setFinderError] = useState<string | null>(null)
  const [featured, setFeatured] = useState<SkinSearchResult[]>(featuredCache ?? [])

  const refreshInfo = useCallback((force = false) => {
    setInfoError(null)
    window.elauncher.skins
      .getInfo(force)
      .then(setInfo)
      .catch((e) => setInfoError(e instanceof Error ? e.message : String(e)))
  }, [])

  const refreshLibrary = useCallback(() => {
    window.elauncher.skins.listSaved().then(setLibrary).catch(console.error)
  }, [])

  useEffect(() => {
    if (active) refreshInfo()
    refreshLibrary()
  }, [active?.uuid, refreshInfo, refreshLibrary])

  // load the curated "popular skins" gallery once
  useEffect(() => {
    if (featuredCache) return
    Promise.all(
      FEATURED.map((n) =>
        window.elauncher.skins
          .search(n)
          .then((r) => (r.ok && r.result ? r.result : null))
          .catch(() => null)
      )
    ).then((results) => {
      const ok = results.filter((r): r is SkinSearchResult => Boolean(r))
      featuredCache = ok
      setFeatured(ok)
    })
  }, [])

  // 3D viewer lifecycle
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const viewer = new SkinViewer({ canvas, width: 300, height: 380, zoom: 0.85 })
    viewer.autoRotate = false
    viewer.animation = new WalkingAnimation()
    viewerRef.current = viewer
    return () => {
      viewer.dispose()
      viewerRef.current = null
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer) return
    viewer.animation = walking ? new WalkingAnimation() : new IdleAnimation()
  }, [walking])

  // load whatever skin should currently be shown
  const shownSkin = preview?.dataUrl ?? info?.dataUrl
  const shownVariant = preview?.variant ?? info?.variant ?? 'classic'
  useEffect(() => {
    const viewer = viewerRef.current
    if (!viewer || !shownSkin) return
    void viewer.loadSkin(shownSkin, { model: shownVariant === 'slim' ? 'slim' : 'default' })
    const activeCape = info?.capes.find((c) => c.active)
    if (!preview && activeCape) {
      viewer.loadCape(activeCape.url).catch(() => viewer.resetCape())
    } else {
      viewer.resetCape()
    }
  }, [shownSkin, shownVariant, preview, info])

  const importSkin = async (): Promise<void> => {
    setBusy(true)
    try {
      const added = await window.elauncher.skins.import()
      if (added) {
        toast.success(`Added "${added.name}" to your skin library`)
        refreshLibrary()
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const saveCurrent = async (): Promise<void> => {
    setBusy(true)
    try {
      const saved = await window.elauncher.skins.saveCurrent(`${active?.name ?? 'My'} skin`)
      toast.success(`Saved "${saved.name}" to your library`)
      refreshLibrary()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const applySavedSkin = async (skin: SavedSkin): Promise<void> => {
    setApplying(skin.id)
    const result = await window.elauncher.skins.apply(skin.id, skin.variant)
    setApplying(null)
    if (result.ok) {
      toast.success(`"${skin.name}" is now your Minecraft skin`)
      setPreview(null)
      refreshInfo(true)
    } else {
      toast.error(result.error ?? 'Skin upload failed')
    }
  }

  const applyBrowsed = async (skin: SkinSearchResult): Promise<void> => {
    setApplying(skin.uuid)
    const result = await window.elauncher.skins.applyUrl(skin.url, skin.variant)
    setApplying(null)
    if (result.ok) {
      toast.success(`${skin.username}'s skin is now yours`)
      setPreview(null)
      refreshInfo(true)
    } else {
      toast.error(result.error ?? 'Skin upload failed')
    }
  }

  const saveBrowsed = async (skin: SkinSearchResult): Promise<void> => {
    setSaving(skin.uuid)
    try {
      const saved = await window.elauncher.skins.saveUrl(skin.username, skin.url, skin.variant)
      toast.success(`Saved "${saved.name}" to your library`)
      refreshLibrary()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(null)
    }
  }

  const applyPreview = async (): Promise<void> => {
    if (!preview) return
    if (preview.savedId) {
      const skin = library.find((s) => s.id === preview.savedId)
      if (skin) return applySavedSkin(skin)
    }
    if (preview.url) {
      setApplying(preview.url)
      const result = await window.elauncher.skins.applyUrl(preview.url, preview.variant)
      setApplying(null)
      if (result.ok) {
        toast.success(`"${preview.name}" is now your Minecraft skin`)
        setPreview(null)
        refreshInfo(true)
      } else {
        toast.error(result.error ?? 'Skin upload failed')
      }
    }
  }

  const previewBrowsed = (skin: SkinSearchResult): void =>
    setPreview({ name: skin.username, dataUrl: skin.dataUrl, variant: skin.variant, url: skin.url })

  const doSearch = async (): Promise<void> => {
    const q = finderQuery.trim()
    if (!q) return
    setFinding(true)
    setFinderError(null)
    setFound(null)
    const r = await window.elauncher.skins.search(q)
    setFinding(false)
    if (r.ok && r.result) setFound(r.result)
    else setFinderError(r.error ?? `No player named "${q}".`)
  }

  const setVariant = (skin: SavedSkin, variant: 'classic' | 'slim'): void => {
    void window.elauncher.skins.rename(skin.id, skin.name, variant).then((skins) => {
      setLibrary(skins)
      if (preview?.savedId === skin.id) setPreview({ ...preview, variant })
    })
  }

  const removeSkin = (skin: SavedSkin): void => {
    if (!confirm(`Remove "${skin.name}" from your skin library?`)) return
    void window.elauncher.skins.remove(skin.id).then((skins) => {
      setLibrary(skins)
      if (preview?.savedId === skin.id) setPreview(null)
    })
  }

  if (!active) {
    return (
      <div>
        <div className="page-header">
          <h1>Skins</h1>
        </div>
        <div className="empty-state">
          <div className="empty-icon">
            <IconUser size={28} />
          </div>
          <h2>Sign in to manage skins</h2>
          <p>Sign in with your Microsoft account (bottom of the sidebar) to view and change your Minecraft skin.</p>
        </div>
      </div>
    )
  }

  const previewApplying = preview?.savedId
    ? applying === preview.savedId
    : preview?.url
      ? applying === preview.url
      : false

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Skins</h1>
          <p className="muted small" style={{ marginTop: 2 }}>
            Find any player's skin, preview in 3D, and apply it to {active.name}'s account.
          </p>
        </div>
        <div className="row">
          <button className="ghost" disabled={busy} onClick={() => void saveCurrent()}>
            <IconDownload size={14} /> Save current skin
          </button>
          <button className="primary" disabled={busy} onClick={() => void importSkin()}>
            <IconUpload size={14} /> Import skin file
          </button>
        </div>
      </div>

      <div className="skins-layout">
        <div className="skin-viewer-card">
          <div className="row" style={{ width: '100%', justifyContent: 'space-between' }}>
            <div>
              <div style={{ fontWeight: 750, fontSize: 14 }}>{preview ? `Previewing: ${preview.name}` : 'Current skin'}</div>
              <div className="small faint" style={{ textTransform: 'capitalize' }}>
                {shownVariant} model
              </div>
            </div>
            <button className="icon-btn" title="Reload from Mojang" onClick={() => refreshInfo(true)}>
              <IconRefresh size={15} />
            </button>
          </div>
          <div className="skin-viewer-canvas">
            <canvas ref={canvasRef} />
          </div>
          <div className="row" style={{ width: '100%', justifyContent: 'center' }}>
            <div className="segmented" style={{ flex: 'none' }}>
              <button className={walking ? 'active' : ''} onClick={() => setWalking(true)}>
                Walking
              </button>
              <button className={!walking ? 'active' : ''} onClick={() => setWalking(false)}>
                Idle
              </button>
            </div>
          </div>
          {preview && (
            <div className="row" style={{ width: '100%' }}>
              <button className="ghost" style={{ flex: 1 }} onClick={() => setPreview(null)}>
                Back to current
              </button>
              <button className="primary" style={{ flex: 1 }} disabled={previewApplying} onClick={() => void applyPreview()}>
                {previewApplying ? 'Applying…' : 'Use this skin'}
              </button>
            </div>
          )}
          {infoError && !preview && (
            <div className="error-banner" style={{ marginBottom: 0 }}>
              <span>{infoError}</span>
            </div>
          )}
          {!preview && info && info.capes.length > 0 && (
            <div className="cape-row">
              {info.capes.map((cape) => (
                <span key={cape.id} className={`cape-chip${cape.active ? ' active' : ''}`}>
                  {cape.alias}
                  {cape.active ? ' ✓' : ''}
                </span>
              ))}
            </div>
          )}
        </div>

        <div>
          {/* ---------- skin browser ---------- */}
          <div className="home-section" style={{ margin: '0 0 12px' }}>
            <h2>
              <IconSearch size={16} /> Find a skin
            </h2>
          </div>
          <form
            className="search-wrap"
            style={{ marginBottom: 14 }}
            onSubmit={(e) => {
              e.preventDefault()
              void doSearch()
            }}
          >
            <IconSearch size={16} />
            <input
              placeholder="Search by player name… (e.g. Technoblade)"
              value={finderQuery}
              onChange={(e) => setFinderQuery(e.target.value)}
            />
            {finding && <span className="small faint" style={{ paddingRight: 8 }}>Searching…</span>}
          </form>

          {finderError && (
            <div className="pill-note" style={{ marginBottom: 14 }}>
              {finderError}
            </div>
          )}

          {found && (
            <div className="skin-grid" style={{ marginBottom: 20 }}>
              <BrowseCard
                skin={found}
                applying={applying === found.uuid}
                saving={saving === found.uuid}
                onPreview={() => previewBrowsed(found)}
                onUse={() => void applyBrowsed(found)}
                onSave={() => void saveBrowsed(found)}
              />
            </div>
          )}

          <div className="home-section" style={{ margin: '0 0 12px' }}>
            <h2 style={{ fontSize: 14 }}>Popular skins</h2>
          </div>
          {featured.length === 0 ? (
            <div className="skin-grid">
              {[0, 1, 2, 3].map((i) => (
                <div key={i} className="skeleton" style={{ height: 190 }} />
              ))}
            </div>
          ) : (
            <div className="skin-grid" style={{ marginBottom: 24 }}>
              {featured.map((skin) => (
                <BrowseCard
                  key={skin.uuid}
                  skin={skin}
                  applying={applying === skin.uuid}
                  saving={saving === skin.uuid}
                  onPreview={() => previewBrowsed(skin)}
                  onUse={() => void applyBrowsed(skin)}
                  onSave={() => void saveBrowsed(skin)}
                />
              ))}
            </div>
          )}

          {/* ---------- local library ---------- */}
          <div className="home-section" style={{ margin: '0 0 14px' }}>
            <h2>
              <IconUser size={16} /> Skin library
            </h2>
            <span className="small faint">{library.length} saved</span>
          </div>
          {library.length === 0 ? (
            <div className="empty-state" style={{ padding: '48px 20px' }}>
              <div className="empty-icon">
                <IconUser size={28} />
              </div>
              <h2>No skins saved yet</h2>
              <p>Search for a player above, import a PNG, or save your current skin to build a library.</p>
            </div>
          ) : (
            <div className="skin-grid">
              {library.map((skin) => (
                <div key={skin.id} className="skin-card">
                  <button
                    style={{ background: 'none', padding: 0 }}
                    title="Preview in 3D"
                    onClick={() =>
                      setPreview({ name: skin.name, dataUrl: skin.dataUrl, variant: skin.variant, savedId: skin.id })
                    }
                  >
                    <SkinFace dataUrl={skin.dataUrl} />
                  </button>
                  <div style={{ textAlign: 'center', minWidth: 0, width: '100%' }}>
                    <div className="skin-name">{skin.name}</div>
                    <div className="small faint">{timeAgo(skin.addedAt)}</div>
                  </div>
                  <div className="segmented" style={{ width: '100%' }}>
                    <button
                      className={skin.variant === 'classic' ? 'active' : ''}
                      style={{ padding: '4px 6px', fontSize: 11 }}
                      title="Classic (wide arms)"
                      onClick={() => setVariant(skin, 'classic')}
                    >
                      Classic
                    </button>
                    <button
                      className={skin.variant === 'slim' ? 'active' : ''}
                      style={{ padding: '4px 6px', fontSize: 11 }}
                      title="Slim (thin arms)"
                      onClick={() => setVariant(skin, 'slim')}
                    >
                      Slim
                    </button>
                  </div>
                  <div className="skin-actions">
                    <button
                      className="primary"
                      style={{ padding: '6px 12px', fontSize: 12 }}
                      disabled={applying === skin.id}
                      onClick={() => void applySavedSkin(skin)}
                    >
                      {applying === skin.id ? (
                        'Applying…'
                      ) : (
                        <>
                          <IconCheck size={13} /> Use
                        </>
                      )}
                    </button>
                    <button className="icon-btn" title="Remove from library" onClick={() => removeSkin(skin)}>
                      <IconTrash size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
