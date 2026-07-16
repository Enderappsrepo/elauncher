import type { NewsItem } from '@shared/types'
import { listLauncherNews } from './cloud'

const CONTENT_BASE = 'https://launchercontent.mojang.com'
const CACHE_TTL_MS = 30 * 60 * 1000

let cache: { items: NewsItem[]; fetchedAt: number } | null = null

interface RawNewsEntry {
  title?: string
  tag?: string
  category?: string
  date?: string
  text?: string
  readMoreLink?: string
  newsType?: string[]
  playPageImage?: { url?: string }
  newsPageImage?: { url?: string }
  image?: { url?: string }
}

interface RawPatchNote {
  title?: string
  version?: string
  date?: string
  body?: string
  shortText?: string
  type?: string
  image?: { url?: string }
}

function absoluteUrl(path?: string): string | undefined {
  if (!path) return undefined
  return path.startsWith('http') ? path : `${CONTENT_BASE}${path.startsWith('/') ? '' : '/'}${path}`
}

async function fetchJson(path: string): Promise<unknown> {
  const res = await fetch(`${CONTENT_BASE}${path}`, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`News feed error ${res.status}`)
  return res.json()
}

/**
 * Launcher (admin-authored) articles are pinned in front of the Mojang feed.
 * They are fetched fresh on every call — the Supabase query is cheap and admins
 * expect a new post to show up right away; only the Mojang feed is cached.
 */
export async function getNews(): Promise<NewsItem[]> {
  const [launcher, mojang] = await Promise.all([fetchLauncherNews(), fetchMojangNews()])
  return [...launcher, ...mojang]
}

function newsId(category: string, date: string, title: string, extra?: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48)
  return extra ? `${category}:${extra}` : `${category}:${date}:${slug}`
}

async function fetchLauncherNews(): Promise<NewsItem[]> {
  try {
    const articles = await listLauncherNews()
    return articles.map((a) => ({
      id: a.id,
      title: a.title,
      tag: 'ELauncher',
      date: a.createdAt,
      text: a.body,
      readMoreUrl: a.linkUrl,
      imageUrl: a.imageUrl,
      category: 'launcher' as const,
      authorName: a.authorName || undefined
    }))
  } catch {
    return []
  }
}

async function fetchMojangNews(): Promise<NewsItem[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) return cache.items

  const items: NewsItem[] = []

  const [newsResult, patchResult] = await Promise.allSettled([
    fetchJson('/v2/news.json') as Promise<{ entries?: RawNewsEntry[] }>,
    fetchJson('/v2/javaPatchNotes.json') as Promise<{ entries?: RawPatchNote[] }>
  ])

  if (newsResult.status === 'fulfilled') {
    for (const entry of newsResult.value.entries ?? []) {
      // only java-relevant news with an image make good dashboard cards
      if (entry.newsType && !entry.newsType.some((t) => t.toLowerCase().includes('news'))) continue
      const imageUrl = absoluteUrl(entry.newsPageImage?.url ?? entry.playPageImage?.url ?? entry.image?.url)
      if (!entry.title) continue
      items.push({
        id: newsId('news', entry.date ?? '', entry.title),
        title: entry.title,
        tag: entry.tag ?? entry.category,
        date: entry.date ?? '',
        text: entry.text ?? '',
        readMoreUrl: entry.readMoreLink,
        imageUrl,
        category: 'news'
      })
    }
  }

  if (patchResult.status === 'fulfilled') {
    for (const entry of (patchResult.value.entries ?? []).slice(0, 6)) {
      if (!entry.title) continue
      items.push({
        id: newsId('patch', entry.date ?? '', entry.title, entry.version),
        title: entry.title,
        tag: entry.type === 'snapshot' ? 'Snapshot' : 'Release',
        date: entry.date ?? '',
        text: entry.shortText ?? '',
        // release articles follow a predictable slug; snapshot slugs don't, so skip those
        readMoreUrl:
          entry.version && entry.type === 'release'
            ? `https://www.minecraft.net/en-us/article/minecraft-java-edition-${entry.version.replace(/\./g, '-')}`
            : undefined,
        imageUrl: absoluteUrl(entry.image?.url),
        category: 'patch-notes'
      })
    }
  }

  items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
  const result = items.slice(0, 24)
  if (result.length > 0) cache = { items: result, fetchedAt: Date.now() }
  return result
}
