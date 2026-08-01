import { useEffect, useState } from 'react'

/**
 * Point the download buttons at the actual latest-release assets.
 *
 * Everything here degrades to the releases page, which is why the fallback URLs
 * are the initial state rather than something applied in a catch: GitHub's API
 * is unauthenticated here and rate-limits by IP, so an unreachable API is a
 * normal condition, not an error worth showing anybody.
 */

const RELEASES = 'https://github.com/Enderappsrepo/elauncher/releases/latest'
const API = 'https://api.github.com/repos/Enderappsrepo/elauncher/releases/latest'

export interface Release {
  version: string | null
  size: string | null
  setupUrl: string
  portableUrl: string
  /** Apple Silicon .dmg (the common case) */
  macUrl: string
  /** Intel .dmg */
  macIntelUrl: string
}

interface Asset {
  name: string
  size: number
  browser_download_url: string
}

export function useRelease(): Release {
  const [release, setRelease] = useState<Release>({
    version: null,
    size: null,
    setupUrl: RELEASES,
    portableUrl: RELEASES,
    macUrl: RELEASES,
    macIntelUrl: RELEASES
  })

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const res = await fetch(API)
        if (!res.ok || !alive) return
        const rel = (await res.json()) as { tag_name?: string; assets?: Asset[] }
        const assets = rel.assets ?? []
        const setup = assets.find((a) => /Setup.*\.exe$/i.test(a.name))
        const portable = assets.find((a) => /Portable.*\.exe$/i.test(a.name))
        const macArm = assets.find((a) => /-arm64\.dmg$/i.test(a.name))
        const macIntel = assets.find((a) => /-x64\.dmg$/i.test(a.name))
        if (!alive) return
        setRelease({
          version: rel.tag_name ?? null,
          size: setup ? `${(setup.size / 1048576).toFixed(0)} MB` : null,
          setupUrl: setup?.browser_download_url ?? RELEASES,
          portableUrl: portable?.browser_download_url ?? RELEASES,
          macUrl: macArm?.browser_download_url ?? RELEASES,
          macIntelUrl: macIntel?.browser_download_url ?? RELEASES
        })
      } catch {
        // keep the fallback links
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  return release
}
