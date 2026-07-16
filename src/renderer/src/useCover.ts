import { useEffect, useState } from 'react'
import type { Instance } from '@shared/types'
import { coverGradient } from './fmt'

/** Custom icon data urls, cached per instance id + icon value. */
const cache = new Map<string, string | null>()

/**
 * Resolves an instance's cover art: a custom image (data url) when one is set,
 * plus the gradient used as fallback / backdrop.
 */
export function useInstanceCover(instance: Instance): { image: string | null; gradient: string } {
  const isFile = instance.icon?.startsWith('file:') ?? false
  const key = `${instance.id}:${instance.icon ?? ''}`
  const [image, setImage] = useState<string | null>(() => cache.get(key) ?? null)

  useEffect(() => {
    if (!isFile) {
      setImage(null)
      return
    }
    if (cache.has(key)) {
      setImage(cache.get(key) ?? null)
      return
    }
    let alive = true
    window.elauncher.instances
      .getIconData(instance.id)
      .then((data) => {
        cache.set(key, data)
        if (alive) setImage(data)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [key, isFile, instance.id])

  return { image: isFile ? image : null, gradient: coverGradient(instance.id, instance.icon) }
}
