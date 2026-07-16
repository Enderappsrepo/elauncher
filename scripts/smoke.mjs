// Smoke test for the install wiring: version manifest, vanilla json+jar,
// fabric profile, loader version lists, and Modrinth search.
// Usage: node scripts/smoke.mjs
import { getVersionList, installVersionTask, installFabric, getLoaderArtifactListFor } from '@xmcl/installer'
import { Version } from '@xmcl/core'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const dir = mkdtempSync(join(tmpdir(), 'elauncher-smoke-'))
console.log('workdir:', dir)

// 1. version manifest
const list = await getVersionList()
const mc = list.versions.find((v) => v.id === '1.21.4')
console.log('manifest ok, latest release:', list.latest.release, '| testing with', mc.id)

// 2. vanilla json + jar
const task = installVersionTask(mc, dir)
let last = 0
await task.startAndWait({
  onUpdate() {
    if (Date.now() - last > 2000) {
      last = Date.now()
      console.log(`vanilla install: ${task.progress}/${task.total}`)
    }
  }
})
console.log('vanilla json+jar installed')

// 3. loader version lists
const fabricLoaders = await getLoaderArtifactListFor('1.21.4')
console.log('fabric loaders for 1.21.4:', fabricLoaders.slice(0, 3).map((l) => l.loader.version).join(', '), '...')
const forgeMeta = await (await fetch('https://files.minecraftforge.net/net/minecraftforge/forge/maven-metadata.json')).json()
const forgeVersions = (forgeMeta['1.20.1'] ?? []).map((v) => v.split('-')[1]).filter(Boolean).reverse()
console.log('forge versions for 1.20.1:', forgeVersions.slice(0, 3).join(', '), '...')
const neoRes = await fetch('https://maven.neoforged.net/api/maven/versions/releases/net/neoforged/neoforge')
const neo = (await neoRes.json()).versions.filter((v) => v.startsWith('21.4.')).slice(-3)
console.log('neoforge versions for 1.21.4:', neo.join(', '))

// 4. fabric profile install
const fabricId = await installFabric({
  minecraftVersion: '1.21.4',
  version: fabricLoaders[0].loader.version,
  minecraft: dir
})
console.log('fabric installed as version id:', fabricId)
const resolved = await Version.parse(dir, fabricId)
console.log('resolved fabric version, mainClass:', resolved.mainClass, '| libraries:', resolved.libraries.length, '| java:', resolved.javaVersion?.component)

// 5. modrinth search + version resolution
const ua = { headers: { 'User-Agent': 'ELauncher/0.1.0 smoke test' } }
const search = await (await fetch('https://api.modrinth.com/v2/search?query=sodium&facets=' + encodeURIComponent(JSON.stringify([["project_type:mod"],["versions:1.21.4"],["categories:fabric"]])), ua)).json()
console.log('modrinth search hits:', search.total_hits, '| first:', search.hits[0].title, search.hits[0].project_id)
const pid = search.hits[0].project_id
const versions = await (await fetch(`https://api.modrinth.com/v2/project/${pid}/version?game_versions=${encodeURIComponent(JSON.stringify(['1.21.4']))}&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`, ua)).json()
const file = versions[0].files.find((f) => f.primary) ?? versions[0].files[0]
console.log('resolved mod version:', versions[0].version_number, '| file:', file.filename, '| sha512:', Boolean(file.hashes.sha512))

console.log('\nSMOKE OK')
