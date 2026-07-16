import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { Instance, NewsItem } from '@shared/types'
import { useAppState } from '../state'
import { useToast } from '../toast'
import { formatDate, formatPlaytime, timeAgo } from '../fmt'
import { useInstanceCover } from '../useCover'
import { newsTagClass } from '../newsUtils'
import { IconChevronDown, IconClock, IconGrid, IconNews, IconPlay, IconPlus, IconStop, IconSwords } from '../icons'

function NewsCard({ item, onOpen }: { item: NewsItem; onOpen: (item: NewsItem) => void }): React.JSX.Element {
  return (
    <div
      className="news-card"
      role="link"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}
    >
      <div className="news-image">
        {item.imageUrl ? (
          <img src={item.imageUrl} alt="" loading="lazy" />
        ) : (
          <div className="news-image-empty">
            <IconNews size={22} />
          </div>
        )}
      </div>
      <div className="news-body">
        <div className="news-meta">
          {item.tag && <span className={`news-tag${newsTagClass(item)}`}>{item.tag}</span>}
          <span>{formatDate(item.date)}</span>
        </div>
        <h4>{item.title}</h4>
        <p>{item.text}</p>
      </div>
    </div>
  )
}

function NewsFeature({ item, onOpen }: { item: NewsItem; onOpen: (item: NewsItem) => void }): React.JSX.Element {
  return (
    <div
      className="news-feature"
      role="link"
      tabIndex={0}
      onClick={() => onOpen(item)}
      onKeyDown={(e) => e.key === 'Enter' && onOpen(item)}
    >
      <div className="news-feature-bg">
        {item.imageUrl && <img src={item.imageUrl} alt="" />}
      </div>
      <div className="news-feature-content">
        <div className="news-meta">
          {item.tag && <span className={`news-tag${newsTagClass(item)}`}>{item.tag}</span>}
          <span>{formatDate(item.date)}</span>
        </div>
        <h3>{item.title}</h3>
        {item.text && <p>{item.text}</p>}
      </div>
    </div>
  )
}

function HeroCover({ instance }: { instance: Instance }): React.JSX.Element {
  const { image, gradient } = useInstanceCover(instance)
  return (
    <div className="home-hero-bg" style={{ background: gradient }}>
      {image && <img src={image} alt="" />}
    </div>
  )
}

function HeroTile({ instance }: { instance: Instance }): React.JSX.Element {
  const { image, gradient } = useInstanceCover(instance)
  return (
    <div className="ibanner-tile" style={{ background: gradient }}>
      {image ? <img src={image} alt="" /> : instance.name.charAt(0).toUpperCase()}
    </div>
  )
}

function RecentTile({ instance }: { instance: Instance }): React.JSX.Element {
  const { image, gradient } = useInstanceCover(instance)
  return (
    <span className="recent-tile" style={{ background: gradient }}>
      {image ? <img src={image} alt="" /> : instance.name.charAt(0).toUpperCase()}
    </span>
  )
}

export default function HomePage(): React.JSX.Element {
  const { instances, runStates, launch, kill } = useAppState()
  const toast = useToast()
  const navigate = useNavigate()
  const [news, setNews] = useState<NewsItem[] | null>(null)
  const [showAllNews, setShowAllNews] = useState(false)

  useEffect(() => {
    window.elauncher.news.get().then(setNews).catch(() => setNews([]))
  }, [])

  const featured = useMemo(() => {
    const running = instances.find((i) => runStates[i.id] === 'running')
    if (running) return running
    const played = instances.filter((i) => i.lastPlayedAt)
    if (played.length === 0) return instances[0]
    return played.reduce((a, b) => ((a.lastPlayedAt ?? 0) >= (b.lastPlayedAt ?? 0) ? a : b))
  }, [instances, runStates])

  const recents = useMemo(
    () =>
      instances
        .filter((i) => i.lastPlayedAt && i.id !== featured?.id)
        .sort((a, b) => (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0))
        .slice(0, 4),
    [instances, featured]
  )

  const totalPlayMs = useMemo(() => instances.reduce((sum, i) => sum + (i.totalPlayMs ?? 0), 0), [instances])
  const runningCount = Object.values(runStates).filter((s) => s === 'running').length

  const onPlay = (id: string): void => {
    void launch(id).then((error) => {
      if (error) toast.error(error)
    })
  }

  const openArticle = (item: NewsItem): void => {
    navigate(`/news/${encodeURIComponent(item.id)}`)
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Home</h1>
          <p className="muted small" style={{ marginTop: 2 }}>
            Welcome back — ready to play?
          </p>
        </div>
        <button className="primary" onClick={() => navigate('/instances')}>
          <IconGrid size={15} /> My instances
        </button>
      </div>

      {featured ? (
        <div className="home-hero" style={{ cursor: 'pointer' }} onClick={() => navigate(`/instances/${featured.id}`)}>
          <HeroCover instance={featured} />
          <div className="home-hero-content">
            <HeroTile instance={featured} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {(runStates[featured.id] ?? 'idle') === 'running' ? (
                <div className="hero-label live">
                  <span className="dot pulse" /> Running now
                </div>
              ) : (
                <div className="hero-label">Jump back in</div>
              )}
              <h2 style={{ fontSize: 26, fontWeight: 800, letterSpacing: '-0.025em' }}>{featured.name}</h2>
              <div className="ibanner-stats">
                <span className={`chip loader-${featured.loader}`}>{featured.loader}</span>
                <span className="stat-chip">{featured.minecraftVersion}</span>
                <span className="stat-chip">
                  <IconClock size={13} /> <b>{formatPlaytime(featured.totalPlayMs)}</b> played
                </span>
                <span className="stat-chip">{timeAgo(featured.lastPlayedAt)}</span>
              </div>
            </div>
            {(runStates[featured.id] ?? 'idle') === 'running' ? (
              <button
                className="danger"
                onClick={(e) => {
                  e.stopPropagation()
                  void kill(featured.id)
                }}
              >
                <IconStop size={14} /> Stop
              </button>
            ) : (
              <button
                className="play"
                style={{ padding: '12px 30px', fontSize: 15 }}
                disabled={(runStates[featured.id] ?? 'idle') !== 'idle'}
                onClick={(e) => {
                  e.stopPropagation()
                  onPlay(featured.id)
                }}
              >
                <IconPlay size={16} /> Play
              </button>
            )}
          </div>
        </div>
      ) : (
        <div className="home-hero">
          <div className="home-hero-bg" style={{ background: 'linear-gradient(120deg, #8b5cf6, #d946ef 60%, #0ea5e9)' }} />
          <div className="home-hero-content">
            <div style={{ flex: 1 }}>
              <div className="hero-label">Get started</div>
              <h2 style={{ fontSize: 26, fontWeight: 800 }}>Create your first instance</h2>
              <p className="muted" style={{ marginTop: 6, maxWidth: 480 }}>
                Pick a Minecraft version and mod loader, add mods, shaders and resource packs — then hit Play.
              </p>
            </div>
            <button className="primary" style={{ padding: '12px 24px' }} onClick={() => navigate('/instances')}>
              <IconPlus size={15} /> New instance
            </button>
          </div>
        </div>
      )}

      <div className="stat-tiles">
        <div className="stat-tile">
          <div className="stat-icon">
            <IconGrid size={18} />
          </div>
          <div>
            <div className="stat-value">{instances.length}</div>
            <div className="stat-label">Instances</div>
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-icon">
            <IconClock size={18} />
          </div>
          <div>
            <div className="stat-value">{formatPlaytime(totalPlayMs)}</div>
            <div className="stat-label">Total playtime</div>
          </div>
        </div>
        <div className="stat-tile">
          <div className="stat-icon" style={{ background: 'var(--green-soft)', color: 'var(--green)' }}>
            <IconSwords size={18} />
          </div>
          <div>
            <div className="stat-value">{runningCount}</div>
            <div className="stat-label">Running now</div>
          </div>
        </div>
      </div>

      {recents.length > 0 && (
        <>
          <div className="home-section">
            <h2>
              <IconClock size={16} /> Recently played
            </h2>
          </div>
          <div className="recent-row">
            {recents.map((i) => (
              <div key={i.id} className="recent-card" onClick={() => navigate(`/instances/${i.id}`)}>
                <RecentTile instance={i} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 650, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {i.name}
                  </div>
                  <div className="small faint">{timeAgo(i.lastPlayedAt)}</div>
                </div>
                <button
                  className="icon-btn"
                  title="Play"
                  disabled={(runStates[i.id] ?? 'idle') !== 'idle'}
                  onClick={(e) => {
                    e.stopPropagation()
                    onPlay(i.id)
                  }}
                >
                  <IconPlay size={15} />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="home-section">
        <h2>
          <IconNews size={16} /> Minecraft news
        </h2>
      </div>
      {news === null ? (
        <>
          <div className="skeleton" style={{ height: 240, marginBottom: 16 }} />
          <div className="news-grid">
            {[0, 1, 2].map((i) => (
              <div key={i} className="skeleton" style={{ height: 250 }} />
            ))}
          </div>
        </>
      ) : news.length === 0 ? (
        <div className="empty-state" style={{ padding: '50px 20px' }}>
          <h2>No news right now</h2>
          <p>Could not reach the news feed. Check your connection and come back later.</p>
        </div>
      ) : (
        <>
          <NewsFeature item={news[0]} onOpen={openArticle} />
          <div className="news-grid">
            {news.slice(1, showAllNews ? undefined : 7).map((item) => (
              <NewsCard key={item.id} item={item} onOpen={openArticle} />
            ))}
          </div>
          {news.length > 7 && (
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 16 }}>
              <button className="ghost" onClick={() => setShowAllNews((v) => !v)}>
                <span style={{ display: 'inline-flex', transform: showAllNews ? 'rotate(180deg)' : 'none' }}>
                  <IconChevronDown size={14} />
                </span>
                {showAllNews ? 'Show less' : `Show ${news.length - 7} more`}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
