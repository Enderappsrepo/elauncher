import { useEffect, useState } from 'react'
import type { MinecraftVersionInfo, ModLoader } from '@shared/types'
import { IconAlert } from '../icons'
import Select from './Select'

interface Props {
  onClose: () => void
  onCreated: (id: string) => void
}

const LOADERS: { id: ModLoader; label: string }[] = [
  { id: 'vanilla', label: 'Vanilla' },
  { id: 'fabric', label: 'Fabric' },
  { id: 'forge', label: 'Forge' },
  { id: 'neoforge', label: 'NeoForge' }
]

export default function CreateInstanceModal({ onClose, onCreated }: Props): React.JSX.Element {
  const [name, setName] = useState('')
  const [versions, setVersions] = useState<MinecraftVersionInfo[]>([])
  const [showSnapshots, setShowSnapshots] = useState(false)
  const [mcVersion, setMcVersion] = useState('')
  const [loader, setLoader] = useState<ModLoader>('vanilla')
  const [loaderVersions, setLoaderVersions] = useState<string[]>([])
  const [loaderVersion, setLoaderVersion] = useState('')
  const [loadingLoaders, setLoadingLoaders] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    window.elauncher.versions
      .minecraft()
      .then((list) => {
        setVersions(list)
        const firstRelease = list.find((v) => v.type === 'release')
        if (firstRelease) setMcVersion(firstRelease.id)
      })
      .catch((e) => setError(`Could not load version list: ${e instanceof Error ? e.message : e}`))
  }, [])

  useEffect(() => {
    if (loader === 'vanilla' || !mcVersion) {
      setLoaderVersions([])
      setLoaderVersion('')
      return
    }
    setLoadingLoaders(true)
    setError(null)
    window.elauncher.versions
      .loader(loader, mcVersion)
      .then((list) => {
        setLoaderVersions(list)
        setLoaderVersion(list[0] ?? '')
        if (list.length === 0) setError(`No ${loader} builds available for Minecraft ${mcVersion}.`)
      })
      .catch((e) => setError(`Could not load ${loader} versions: ${e instanceof Error ? e.message : e}`))
      .finally(() => setLoadingLoaders(false))
  }, [loader, mcVersion])

  const create = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const instance = await window.elauncher.instances.create({
        name: name || `Minecraft ${mcVersion}`,
        minecraftVersion: mcVersion,
        loader,
        loaderVersion: loader === 'vanilla' ? undefined : loaderVersion
      })
      onCreated(instance.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const visibleVersions = versions.filter((v) => v.type === 'release' || showSnapshots)
  const canCreate = Boolean(mcVersion) && (loader === 'vanilla' || Boolean(loaderVersion)) && !busy

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>New instance</h2>
        {error && (
          <div className="error-banner" style={{ marginBottom: 0 }}>
            <IconAlert size={16} />
            <span>{error}</span>
          </div>
        )}
        <div className="field">
          <label>Name</label>
          <input
            value={name}
            placeholder={mcVersion ? `Minecraft ${mcVersion}` : 'My instance'}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </div>
        <div className="field">
          <label>Minecraft version</label>
          <Select
            value={mcVersion}
            onChange={setMcVersion}
            placeholder="Loading versions…"
            options={visibleVersions.map((v) => ({
              value: v.id,
              label: v.type !== 'release' ? `${v.id} (${v.type})` : v.id
            }))}
          />
          <label className="checkbox-row">
            <input type="checkbox" checked={showSnapshots} onChange={(e) => setShowSnapshots(e.target.checked)} />
            Show snapshots
          </label>
        </div>
        <div className="field">
          <label>Mod loader</label>
          <div className="segmented">
            {LOADERS.map((l) => (
              <button key={l.id} className={loader === l.id ? 'active' : ''} onClick={() => setLoader(l.id)}>
                {l.label}
              </button>
            ))}
          </div>
        </div>
        {loader !== 'vanilla' && (
          <div className="field">
            <label>{loader} version</label>
            <Select
              value={loaderVersion}
              onChange={setLoaderVersion}
              disabled={loadingLoaders || loaderVersions.length === 0}
              placeholder={loadingLoaders ? 'Loading…' : 'No versions available'}
              options={loaderVersions.map((v) => ({ value: v, label: v }))}
            />
          </div>
        )}
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: 4 }}>
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button className="primary" disabled={!canCreate} onClick={() => void create()}>
            {busy ? 'Creating…' : 'Create instance'}
          </button>
        </div>
      </div>
    </div>
  )
}
