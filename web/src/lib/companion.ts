import { useEffect, useState } from 'react'

/**
 * The ELauncher NVMP Companion download.
 *
 * The companion is one fixed-name asset on the launcher's GitHub release. Nothing links to it
 * blind (releases/latest/download/<asset>): that URL is a GitHub 404 whenever the newest release
 * does not carry the asset, which is the case before the first release that ships it, after a
 * local `npm run release`, and in the minutes between the launcher's publish and the companion's
 * upload in the Release workflow. The landing page and the panel's NV:MP setup tab both look the
 * asset up on the latest release and only offer a download when it is there.
 *
 * Only the latest release is linked directly. An older release's companion may not match the host's
 * current upload protocol, so no download button ever points at one.
 *
 * When the lookup itself fails (GitHub's API unreachable, rate-limited or not answering), the landing
 * page and the panel cannot tell which release carries the exe. They link to RELEASES_PAGE, GitHub's
 * list of releases, and say to take the exe from the newest release that lists it. That page never
 * 404s, and it is never a guessed asset URL.
 *
 * An asset only counts once GitHub reports it uploaded: one still uploading, or left behind by a
 * failed upload, is listed too but its URL is a 404.
 */
export const COMPANION_ASSET = 'ELauncher-NVMP-Companion.exe'

export const LATEST_RELEASE_API = 'https://api.github.com/repos/Enderappsrepo/elauncher/releases/latest'

/** GitHub's list of the launcher's releases (not /releases/latest, which may lack the companion). */
export const RELEASES_PAGE = 'https://github.com/Enderappsrepo/elauncher/releases'

export interface ReleaseAsset {
  name: string
  size: number
  browser_download_url: string
  /** 'uploaded' once the file is there; 'open' while it uploads, 'starter' after a failed upload */
  state?: string
}

/** The companion on the latest release: its verified download, or 'missing' when that release has none. */
export type CompanionDownload = { url: string; size: string } | 'missing'

/** Finds the companion on a release's asset list; only an asset GitHub reports uploaded counts. */
export function companionDownload(assets: readonly ReleaseAsset[] | null | undefined): CompanionDownload {
  const asset = assets?.find(
    (a) => a.name === COMPANION_ASSET && typeof a.browser_download_url === 'string' && (a.state === undefined || a.state === 'uploaded')
  )
  return asset ? { url: asset.browser_download_url, size: `${(asset.size / 1048576).toFixed(0)} MB` } : 'missing'
}

/**
 * What the panel offers: the companion's verified download on the latest release, 'releases' when
 * the lookup itself failed (GitHub's API is unauthenticated and rate-limits by IP, so that is a
 * normal condition: the landing page's fallback, GitHub's list of releases, is offered instead), or
 * null while the lookup runs and when the latest release has no companion (nothing to offer yet).
 */
export type CompanionLink = { url: string; size: string } | 'releases' | null

export function useCompanionDownload(): CompanionLink {
  const [link, setLink] = useState<CompanionLink>(null)
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(LATEST_RELEASE_API)
        if (!alive) return
        if (!res.ok) {
          setLink('releases')
          return
        }
        const found = companionDownload(((await res.json()) as { assets?: ReleaseAsset[] }).assets)
        if (alive && found !== 'missing') setLink(found)
      } catch {
        if (alive) setLink('releases')
      }
    })()
    return () => {
      alive = false
    }
  }, [])
  return link
}
