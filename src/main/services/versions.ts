import { getVersionList, getLoaderArtifactListFor } from '@xmcl/installer'
import type { MinecraftVersion } from '@xmcl/installer'
import type { MinecraftVersionInfo, ModLoader } from '@shared/types'

let cachedManifest: MinecraftVersion[] | null = null

export async function getMinecraftVersions(): Promise<MinecraftVersionInfo[]> {
  const list = await getVersionList()
  cachedManifest = list.versions
  return list.versions.map((v) => ({
    id: v.id,
    type: v.type as MinecraftVersionInfo['type'],
    releaseTime: v.releaseTime
  }))
}

export async function getVersionMeta(id: string): Promise<MinecraftVersion> {
  if (!cachedManifest) {
    cachedManifest = (await getVersionList()).versions
  }
  const meta = cachedManifest.find((v) => v.id === id)
  if (!meta) throw new Error(`Unknown Minecraft version: ${id}`)
  return meta
}

/**
 * Map a NeoForge artifact version to its Minecraft version.
 * Old scheme: 21.1.77 -> MC 1.21.1. New scheme (since MC dropped the "1." prefix): 26.2.0.15 -> MC 26.2.
 */
function neoForgeToMinecraft(neoVersion: string): string {
  const [major, minor] = neoVersion.split('.')
  if (Number(major) >= 26) return `${major}.${minor}`
  return minor === '0' ? `1.${major}` : `1.${major}.${minor}`
}

export async function getLoaderVersions(loader: ModLoader, mcVersion: string): Promise<string[]> {
  switch (loader) {
    case 'vanilla':
      return []
    case 'fabric': {
      const artifacts = await getLoaderArtifactListFor(mcVersion)
      return artifacts.map((a) => a.loader.version)
    }
    case 'forge': {
      // The HTML scraper in @xmcl/installer breaks on the current Forge site; use the maven metadata JSON instead
      const res = await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json')
      if (!res.ok) throw new Error(`Failed to fetch Forge versions (${res.status})`)
      const data = (await res.json()) as Record<string, string[]>
      return (data[mcVersion] ?? []).map((v) => v.split('-')[1]).filter(Boolean).reverse()
    }
    case 'neoforge': {
      const res = await fetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')
      if (!res.ok) throw new Error(`Failed to fetch NeoForge versions (${res.status})`)
      const data = (await res.json()) as { versions: string[] }
      return data.versions.filter((v) => neoForgeToMinecraft(v) === mcVersion).reverse()
    }
  }
}
