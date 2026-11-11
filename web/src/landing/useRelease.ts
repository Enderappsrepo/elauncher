import { useEffect, useState } from 'react'
import { LATEST_RELEASE_API, companionDownload, type CompanionDownload, type ReleaseAsset } from '@web/lib/companion'

/**
 * Point the download buttons at the actual latest-release assets.
 *
 * Everything here degrades to the releases page, which is why the fallback URLs
 * are the initial state rather than something applied in a catch: GitHub's API
 * is unauthenticated here and rate-limits by IP, so an unreachable API is a
 * normal condition, not an error worth showing anybody.
 *
 * The NVMP Companion is the exception: it has no fallback asset link, because the
 * latest release may not carry it yet. Its button appears only once the API has
 * shown the asset on the latest release (see web/src/lib/companion.ts). When the
 * lookup fails, or has not answered within COMPANION_LOOKUP_PATIENCE_MS, its state
 * is 'unknown' and the landing links to GitHub's releases list instead; a late
 * answer still replaces that with the verified state.
 */

const RELEASES = 'https://github.com/Enderappsrepo/elauncher/releases/latest'

/** How long the companion section waits for GitHub's API before offering the releases list. */
export const COMPANION_LOOKUP_PATIENCE_MS = 8000

export interface Release {
  version: string | null
  size: string | null
  setupUrl: string
  portableUrl: string
  /** Apple Silicon .dmg (the common case) */
  macUrl: string
  /** Intel .dmg */
  macIntelUrl: string
  /**
   * ELauncher NVMP Companion (Windows, portable), verified on the latest release. null while the
   * lookup runs, 'missing' when the latest release does not carry it, and 'unknown' when the lookup
   * failed (API unreachable, rate-limited, or no answer yet after COMPANION_LOOKUP_PATIENCE_MS)
   */
  companion: CompanionDownload | 'unknown' | null
}

export function useRelease(): Release {
  const [release, setRelease] = useState<Release>({
    version: null,
    size: null,
    setupUrl: RELEASES,
    portableUrl: RELEASES,
    macUrl: RELEASES,
    macIntelUrl: RELEASES,
    companion: null
  })

  useEffect(() => {
    let alive = true
    // only a lookup that has not settled becomes 'unknown'; a verified answer is never downgraded
    const unknown = (): void => {
      if (alive) setRelease((r) => (r.companion === null ? { ...r, companion: 'unknown' } : r))
    }
    const patience = setTimeout(unknown, COMPANION_LOOKUP_PATIENCE_MS)
    void (async () => {
      try {
        const res = await fetch(LATEST_RELEASE_API)
        if (!alive) return
        if (!res.ok) {
          // 403/429 when rate-limited: the launcher buttons keep their fallback links
          clearTimeout(patience)
          unknown()
          return
        }
        const rel = (await res.json()) as { tag_name?: string; assets?: ReleaseAsset[] }
        const assets = rel.assets ?? []
        // anchored to the launcher's artifact names so other .exe assets on the release never match
        const setup = assets.find((a) => /^ELauncher-Setup-.*\.exe$/i.test(a.name))
        const portable = assets.find((a) => /^ELauncher-Portable-.*\.exe$/i.test(a.name))
        const macArm = assets.find((a) => /-arm64\.dmg$/i.test(a.name))
        const macIntel = assets.find((a) => /-x64\.dmg$/i.test(a.name))
        if (!alive) return
        clearTimeout(patience)
        setRelease({
          version: rel.tag_name ?? null,
          size: setup ? `${(setup.size / 1048576).toFixed(0)} MB` : null,
          setupUrl: setup?.browser_download_url ?? RELEASES,
          portableUrl: portable?.browser_download_url ?? RELEASES,
          macUrl: macArm?.browser_download_url ?? RELEASES,
          macIntelUrl: macIntel?.browser_download_url ?? RELEASES,
          companion: companionDownload(assets)
        })
      } catch {
        // keep the fallback links
        clearTimeout(patience)
        unknown()
      }
    })()
    return () => {
      alive = false
      clearTimeout(patience)
    }
  }, [])

  return release
}
