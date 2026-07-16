import { useEffect, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type { NewsItem } from '@shared/types'
import { formatDate } from '../fmt'
import { newsTagClass } from '../newsUtils'
import { IconExternal, IconNews } from '../icons'

export default function NewsArticlePage(): React.JSX.Element {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [article, setArticle] = useState<NewsItem | null | undefined>(undefined)

  useEffect(() => {
    if (!id) {
      setArticle(null)
      return
    }
    window.elauncher.news
      .get()
      .then((items) => setArticle(items.find((item) => item.id === id) ?? null))
      .catch(() => setArticle(null))
  }, [id])

  if (article === undefined) {
    return (
      <div>
        <div className="skeleton" style={{ height: 280, marginBottom: 20 }} />
        <div className="skeleton" style={{ height: 28, width: '60%', marginBottom: 12 }} />
        <div className="skeleton" style={{ height: 14, width: '30%', marginBottom: 24 }} />
        <div className="skeleton" style={{ height: 120 }} />
      </div>
    )
  }

  if (!article) {
    return (
      <div className="empty-state">
        <div className="empty-icon">
          <IconNews size={28} />
        </div>
        <h2>Article not found</h2>
        <p>This news item may have been removed or is no longer available.</p>
        <button className="ghost" onClick={() => navigate('/')}>
          Back to Home
        </button>
      </div>
    )
  }

  return (
    <div className="news-article">
      <button className="ghost news-back" onClick={() => navigate('/')}>
        ← Back to Home
      </button>

      <div className="news-article-hero">
        {article.imageUrl ? (
          <img src={article.imageUrl} alt="" />
        ) : (
          <div className="news-image-empty">
            <IconNews size={36} />
          </div>
        )}
        <div className="news-article-hero-overlay" />
        <div className="news-article-hero-content">
          <div className="news-meta">
            {article.tag && <span className={`news-tag${newsTagClass(article)}`}>{article.tag}</span>}
            <span>{formatDate(article.date)}</span>
            {article.authorName && <span>by {article.authorName}</span>}
          </div>
          <h1>{article.title}</h1>
        </div>
      </div>

      <div className="news-article-body card">
        {article.text ? (
          <div className="news-article-text">{article.text}</div>
        ) : (
          <p className="muted">No preview text is available for this article.</p>
        )}
        {article.readMoreUrl && (
          <div className="news-article-actions">
            <button className="primary" onClick={() => window.open(article.readMoreUrl, '_blank')}>
              <IconExternal size={14} /> Read full article
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
