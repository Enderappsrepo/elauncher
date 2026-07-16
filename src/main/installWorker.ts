/**
 * Runs inside an Electron utilityProcess. Performs the heavy install work
 * (version json/jar, java runtime, mod loader, libraries & assets) off the
 * main process so the UI stays responsive during large downloads.
 */
import { existsSync, statSync, writeFileSync, readFileSync } from 'fs'
import { join } from 'path'
import { MinecraftFolder, Version } from '@xmcl/core'
import type { ResolvedVersion } from '@xmcl/core'
import {
  getVersionList,
  installVersionTask,
  installDependenciesTask,
  installFabric,
  installForgeTask,
  installNeoForgedTask,
  fetchJavaRuntimeManifest,
  installJavaRuntimeTask
} from '@xmcl/installer'
import type { Task } from '@xmcl/task'
import { downloadAgent, describeError, withRetries } from './net'
import { readJson, writeJson } from './store'

export interface InstallJob {
  instanceId: string
  minecraftVersion: string
  loader: 'vanilla' | 'fabric' | 'forge' | 'neoforge'
  loaderVersion?: string
  sharedDir: string
  javaDir: string
  instanceDir: string
}

export type WorkerMessage =
  | { type: 'progress'; phase: string; progress: number }
  | { type: 'done'; versionId: string; javaPath: string }
  | { type: 'error'; message: string }

const port = process.parentPort

function send(msg: WorkerMessage): void {
  port.postMessage(msg)
}

async function runTask<T>(task: Task<T>, phase: string): Promise<T> {
  send({ type: 'progress', phase, progress: -1 })
  const timer = setInterval(() => {
    send({
      type: 'progress',
      phase,
      progress: task.total > 0 ? Math.min(task.progress / task.total, 1) : -1
    })
  }, 300)
  try {
    return await task.startAndWait()
  } finally {
    clearInterval(timer)
  }
}

function javaRuntimeIsComplete(
  destination: string,
  manifest: Awaited<ReturnType<typeof fetchJavaRuntimeManifest>>
): boolean {
  for (const [path, entry] of Object.entries(manifest.files)) {
    if (entry.type !== 'file') continue
    const p = join(destination, path)
    if (!existsSync(p) || statSync(p).size !== entry.downloads.raw.size) return false
  }
  return true
}

async function ensureJava(job: InstallJob, resolved: ResolvedVersion): Promise<string> {
  const component = resolved.javaVersion?.component ?? 'jre-legacy'
  const destination = join(job.javaDir, component)
  const exe =
    process.platform === 'win32' ? join(destination, 'bin', 'javaw.exe') : join(destination, 'bin', 'java')
  const marker = join(destination, '.elauncher-complete')
  if (existsSync(exe) && existsSync(marker)) return exe

  const manifest = await fetchJavaRuntimeManifest({ target: component, dispatcher: downloadAgent })
  await withRetries(() =>
    runTask(installJavaRuntimeTask({ destination, manifest, dispatcher: downloadAgent }), `Downloading Java (${component})`)
  )
  if (!javaRuntimeIsComplete(destination, manifest)) {
    await withRetries(() =>
      runTask(installJavaRuntimeTask({ destination, manifest, dispatcher: downloadAgent }), `Repairing Java (${component})`)
    )
    if (!javaRuntimeIsComplete(destination, manifest)) {
      throw new Error('Java runtime download is incomplete even after a repair attempt. Please try again.')
    }
  }
  if (!existsSync(exe)) throw new Error(`Java runtime installation failed: ${exe} not found`)
  writeFileSync(marker, new Date().toISOString())
  return exe
}

interface InstanceMeta {
  versionId?: string
}

function fileOk(path: string, expectedSize?: number): boolean {
  try {
    const stat = statSync(path)
    return stat.size > 0 && (expectedSize === undefined || expectedSize <= 0 || stat.size === expectedSize)
  } catch {
    return false
  }
}

/**
 * Fast existence + size check of the version jar, all libraries and all assets.
 * Lets repeat launches skip the full (hash-validating, network-bound) install task,
 * which takes a long time for the ~5000 asset files of a modern version.
 */
function dependenciesLookComplete(resolved: ResolvedVersion, sharedDir: string): boolean {
  const folder = MinecraftFolder.from(sharedDir)

  const clientJar = folder.getVersionJar(resolved.minecraftVersion)
  if (!fileOk(clientJar, resolved.downloads?.client?.size)) return false

  for (const lib of resolved.libraries) {
    if (!fileOk(folder.getLibraryByPath(lib.download.path), lib.download.size)) return false
  }

  const assetIndexPath = folder.getAssetsIndex(resolved.assets)
  if (!fileOk(assetIndexPath)) return false
  try {
    const index = JSON.parse(readFileSync(assetIndexPath, 'utf-8')) as {
      objects: Record<string, { hash: string; size: number }>
    }
    for (const { hash, size } of Object.values(index.objects)) {
      if (!fileOk(join(folder.getPath('assets', 'objects', hash.slice(0, 2), hash)), size)) return false
    }
  } catch {
    return false
  }
  return true
}

async function ensureLoader(job: InstallJob, javaPath: string): Promise<string> {
  if (job.loader === 'vanilla') return job.minecraftVersion
  if (!job.loaderVersion) throw new Error(`No ${job.loader} version selected for this instance`)

  const metaFile = join(job.instanceDir, 'elauncher-meta.json')
  const meta = readJson<InstanceMeta>(metaFile, {})
  if (meta.versionId) {
    const jsonPath = join(job.sharedDir, 'versions', meta.versionId, `${meta.versionId}.json`)
    if (existsSync(jsonPath)) return meta.versionId
  }

  let versionId: string
  switch (job.loader) {
    case 'fabric':
      versionId = await installFabric({
        minecraftVersion: job.minecraftVersion,
        version: job.loaderVersion,
        minecraft: job.sharedDir
      })
      break
    case 'forge':
      versionId = await runTask(
        installForgeTask({ mcversion: job.minecraftVersion, version: job.loaderVersion }, job.sharedDir, {
          java: javaPath,
          dispatcher: downloadAgent
        }),
        `Installing Forge ${job.loaderVersion}`
      )
      break
    case 'neoforge':
      versionId = await runTask(
        installNeoForgedTask('neoforge', job.loaderVersion, job.sharedDir, {
          java: javaPath,
          dispatcher: downloadAgent
        }),
        `Installing NeoForge ${job.loaderVersion}`
      )
      break
  }
  writeJson(metaFile, { ...meta, versionId } satisfies InstanceMeta)
  return versionId
}

async function install(job: InstallJob): Promise<{ versionId: string; javaPath: string }> {
  const folder = MinecraftFolder.from(job.sharedDir)

  // 1. vanilla version json + jar (skip the network entirely when both are present)
  send({ type: 'progress', phase: 'Verifying files', progress: -1 })
  const versionJsonPresent = existsSync(folder.getVersionJson(job.minecraftVersion))
  if (!versionJsonPresent || !fileOk(folder.getVersionJar(job.minecraftVersion))) {
    const list = await getVersionList()
    const versionMeta = list.versions.find((v) => v.id === job.minecraftVersion)
    if (!versionMeta) throw new Error(`Unknown Minecraft version: ${job.minecraftVersion}`)
    await withRetries(() =>
      runTask(
        installVersionTask(versionMeta, job.sharedDir, { dispatcher: downloadAgent }),
        `Downloading Minecraft ${job.minecraftVersion}`
      )
    )
  }

  // 2. java (needed for launching and forge/neoforge post-processors)
  const vanilla = await Version.parse(job.sharedDir, job.minecraftVersion)
  const javaPath = await ensureJava(job, vanilla)

  // 3. mod loader
  const versionId = await ensureLoader(job, javaPath)

  // 4. libraries + assets of the final version
  const resolved = await Version.parse(job.sharedDir, versionId)
  send({ type: 'progress', phase: 'Verifying files', progress: -1 })
  if (!dependenciesLookComplete(resolved, job.sharedDir)) {
    await withRetries(() =>
      runTask(installDependenciesTask(resolved, { dispatcher: downloadAgent }), 'Downloading libraries & assets')
    )
  }

  return { versionId, javaPath }
}

port.on('message', (e: Electron.MessageEvent) => {
  const job = e.data as InstallJob
  install(job)
    .then((result) => send({ type: 'done', ...result }))
    .catch((err) => send({ type: 'error', message: describeError(err) }))
})
