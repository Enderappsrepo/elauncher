import { memo, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Instance, InstanceRunState, ModLoader, ProgressEvent } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { formatPlaytime, timeAgo } from '../fmt'
import { useInstanceCover } from '../useCover'
import {
  IconClock,
  IconCopy,
  IconExport,
  IconFolder,
  IconGrid,
  IconImage,
  IconPlay,
  IconPlus,
  IconSearch,
  IconStop,
  IconTrash
} from '../icons'
import Menu from '../components/Menu'
import CreateInstanceModal from '../components/CreateInstanceModal'
import CoverPickerModal from '../components/CoverPickerModal'

type SortMode = 'recent' | 'name' | 'playtime'
type LoaderFilter = 'all' | ModLoader

const LOADER_LABELS: Record<ModLoader, string> = {
  fabric: 'Fabric',
  forge: 'Forge',
  neoforge: 'NeoForge',
  vanilla: 'Vanilla'
}
const LOADER_ORDER: ModLoader[] = ['fabric', 'forge', 'neoforge', 'vanilla']

interface CardProps {
  instance: Instance
  state: InstanceRunState
  prog?: ProgressEvent
  /** newer cloud modpack version available */
  updateAvailable?: string
  onPlay: (id: string) => void
  onStop: (id: string) => void
  onDelete: (instance: Instance) => void
  onDuplicate: (id: string) => void
  onExport: (id: string) => void
  onChangeCover: (instance: Instance) => void
}

const InstanceCard = memo(function InstanceCard({
  instance,
  state,
  prog,
  updateAvailable,
  onPlay,
  onStop,
  onDelete,
  onDuplicate,
  onExport,
  onChangeCover
}: CardProps): React.JSX.Element {
  const navigate = useNavigate()
  const { image, gradient } = useInstanceCover(instance)

  return (
    <div
      className={`icard${state === 'running' ? ' running' : ''}`}
      onClick={() => navigate(`/instances/${instance.id}`)}
    >
      <div className="cover icard-cover" style={{ background: gradient }}>
        {image ? <img src={image} alt="" loading="lazy" /> : <div className="cover-grid" />}
        <div className="icard-chips">
          {updateAvailable && state === 'idle' && (
            <span className="chip update on-banner" title={`Version ${updateAvailable} is available`}>
              Update
            </span>
          )}
          {state === 'running' && (
            <span className="chip running on-banner">
              <span className="dot pulse" /> Running
            </span>
          )}
        </div>
        {state === 'running' ? (
          <button
            className="icard-fab stop"
            title="Stop"
            onClick={(e) => {
              e.stopPropagation()
              onStop(instance.id)
            }}
          >
            <IconStop size={16} />
          </button>
        ) : state === 'idle' ? (
          <button
            className="icard-fab"
            title="Play"
            onClick={(e) => {
              e.stopPropagation()
              onPlay(instance.id)
            }}
          >
            <IconPlay size={16} />
          </button>
        ) : null}
      </div>
      <div className="icard-body">
        <div className="row" style={{ justifyContent: 'space-between', gap: 6 }}>
          <h3 style={{ flex: 1, minWidth: 0 }}>{instance.name}</h3>
          <Menu>
            <button onClick={() => onChangeCover(instance)}>
              <IconImage size={15} /> Change cover
            </button>
            <button onClick={() => void window.elauncher.instances.openFolder(instance.id)}>
              <IconFolder size={15} /> Open folder
            </button>
            <button onClick={() => onDuplicate(instance.id)}>
              <IconCopy size={15} /> Duplicate
            </button>
            <button onClick={() => onExport(instance.id)}>
              <IconExport size={15} /> Export modpack
            </button>
            <hr />
            <button className="danger-item" onClick={() => onDelete(instance)}>
              <IconTrash size={15} /> Delete
            </button>
          </Menu>
        </div>
        <div className="icard-meta">
          <span className={`chip loader-${instance.loader}`}>{instance.loader}</span>
          <span>{instance.minecraftVersion}</span>
          <span className="sep">·</span>
          <span title="Play time">
            <IconClock size={10} /> {formatPlaytime(instance.totalPlayMs)}
          </span>
          <span className="sep">·</span>
          <span>{timeAgo(instance.lastPlayedAt)}</span>
        </div>
        {state === 'installing' && prog && (
          <>
            <span className="small muted" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {prog.phase}
              {prog.progress >= 0 ? ` ${Math.round(prog.progress * 100)}%` : ''}
            </span>
            <div className="progress-track">
              <div
                className={`progress-fill${prog.progress < 0 ? ' indeterminate' : ''}`}
                style={{ width: prog.progress >= 0 ? `${Math.round(prog.progress * 100)}%` : undefined }}
              />
            </div>
          </>
        )}
      </div>
    </div>
  )
})

export default function InstancesPage(): React.JSX.Element {
  const { instances, runStates, progress, refreshInstances, launch, kill, cloudUpdates } = useAppState()
  const toast = useToast()
  const navigate = useNavigate()
  const [showCreate, setShowCreate] = useState(false)
  const [filter, setFilter] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [loaderFilter, setLoaderFilter] = useState<LoaderFilter>('all')
  const [coverTarget, setCoverTarget] = useState<Instance | null>(null)

  const counts = useMemo(() => {
    const c: Record<ModLoader, number> = { fabric: 0, forge: 0, neoforge: 0, vanilla: 0 }
    for (const i of instances) c[i.loader]++
    return c
  }, [instances])

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    let filtered = loaderFilter === 'all' ? [...instances] : instances.filter((i) => i.loader === loaderFilter)
    if (q) {
      filtered = filtered.filter(
        (i) => i.name.toLowerCase().includes(q) || i.minecraftVersion.includes(q) || i.loader.includes(q)
      )
    }
    switch (sort) {
      case 'name':
        return filtered.sort((a, b) => a.name.localeCompare(b.name))
      case 'playtime':
        return filtered.sort((a, b) => (b.totalPlayMs ?? 0) - (a.totalPlayMs ?? 0))
      default:
        return filtered.sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) || b.createdAt - a.createdAt)
    }
  }, [instances, filter, sort, loaderFilter])

  const onPlay = (id: string): void => {
    void launch(id).then((error) => {
      if (error) toast.error(error)
    })
  }

  const onStop = (id: string): void => {
    void kill(id)
  }

  const onDelete = (instance: Instance): void => {
    if (!confirm(`Delete "${instance.name}" and all its files (worlds, mods, configs)? This cannot be undone.`)) return
    void window.elauncher.instances.remove(instance.id).then(() => {
      void refreshInstances()
      toast.success(`Deleted "${instance.name}"`)
    })
  }

  const onDuplicate = (id: string): void => {
    void window.elauncher.instances.duplicate(id).then(async (copy) => {
      await refreshInstances()
      toast.success(`Duplicated as "${copy.name}"`)
    })
  }

  const onExport = (id: string): void => {
    void window.elauncher.packs.exportInstance(id).then((result) => {
      if (result.ok) toast.success('Modpack exported')
      else if (result.error !== 'cancelled') toast.error(result.error ?? 'Export failed')
    })
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Instances</h1>
          {instances.length > 0 && (
            <p className="muted small" style={{ marginTop: 2 }}>
              {instances.length} instance{instances.length === 1 ? '' : 's'}
              {Object.keys(cloudUpdates).length > 0 &&
                ` · ${Object.keys(cloudUpdates).length} with updates available`}
            </p>
          )}
        </div>
        <div className="toolbar-row">
          {instances.length > 0 && (
            <>
              <div className="segmented">
                <button className={sort === 'recent' ? 'active' : ''} onClick={() => setSort('recent')}>
                  Recent
                </button>
                <button className={sort === 'name' ? 'active' : ''} onClick={() => setSort('name')}>
                  A–Z
                </button>
                <button className={sort === 'playtime' ? 'active' : ''} onClick={() => setSort('playtime')}>
                  Playtime
                </button>
              </div>
              <div className="search-wrap" style={{ width: 200 }}>
                <IconSearch size={15} />
                <input placeholder="Search…" value={filter} onChange={(e) => setFilter(e.target.value)} />
              </div>
            </>
          )}
          <button className="primary" onClick={() => setShowCreate(true)}>
            <IconPlus size={15} /> New instance
          </button>
        </div>
      </div>

      {instances.length > 0 && (
        <div className="filter-chips">
          <button className={`chip-btn${loaderFilter === 'all' ? ' active' : ''}`} onClick={() => setLoaderFilter('all')}>
            All <span className="cnt">{instances.length}</span>
          </button>
          {LOADER_ORDER.filter((l) => counts[l] > 0).map((l) => (
            <button
              key={l}
              className={`chip-btn${loaderFilter === l ? ' active' : ''}`}
              onClick={() => setLoaderFilter(l)}
            >
              {LOADER_LABELS[l]} <span className="cnt">{counts[l]}</span>
            </button>
          ))}
        </div>
      )}

      {instances.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">
            <IconGrid size={28} />
          </div>
          <h2>No instances yet</h2>
          <p>Create an instance to pick a Minecraft version and start playing.</p>
          <button className="primary" style={{ marginTop: 14 }} onClick={() => setShowCreate(true)}>
            <IconPlus size={15} /> Create your first instance
          </button>
        </div>
      ) : visible.length === 0 ? (
        <div className="empty-state">
          <h2>No matches</h2>
          <p>
            Nothing matches
            {filter.trim() ? ` "${filter.trim()}"` : ''}
            {loaderFilter !== 'all' ? ` in ${LOADER_LABELS[loaderFilter]}` : ''}.
          </p>
        </div>
      ) : (
        <div className="instance-grid">
          {visible.map((i) => (
            <InstanceCard
              key={i.id}
              instance={i}
              state={runStates[i.id] ?? 'idle'}
              prog={progress[i.id]}
              updateAvailable={cloudUpdates[i.id]?.version}
              onPlay={onPlay}
              onStop={onStop}
              onDelete={onDelete}
              onDuplicate={onDuplicate}
              onExport={onExport}
              onChangeCover={setCoverTarget}
            />
          ))}
        </div>
      )}
      {showCreate && (
        <CreateInstanceModal
          onClose={() => setShowCreate(false)}
          onCreated={(id) => {
            setShowCreate(false)
            void refreshInstances().then(() => navigate(`/instances/${id}`))
          }}
        />
      )}
      {coverTarget && (
        <CoverPickerModal
          instance={coverTarget}
          onClose={() => setCoverTarget(null)}
          onChanged={() => {
            setCoverTarget(null)
            void refreshInstances()
          }}
        />
      )}
    </div>
  )
}
