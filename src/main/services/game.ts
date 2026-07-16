import { join } from 'path'
import type { ChildProcess } from 'child_process'
import { BrowserWindow, utilityProcess } from 'electron'
import { Version, launch, createMinecraftProcessWatcher } from '@xmcl/core'
import type { GameLogEvent, GameStateEvent, Instance, InstanceRunState, ProgressEvent } from '@shared/types'
import { instanceDir, javaDir, sharedDir } from '../paths'
import type { InstallJob, WorkerMessage } from '../installWorker'
import { addPlaytime, getInstance, touchLastPlayed } from './instances'
import { getSettings } from './settings'
import { getActiveSession } from './auth'
import { autoMemoryMiB, optimizedFlagsFor, raisePriority } from './perf'

const MAX_LOG_LINES = 1000

const states = new Map<string, InstanceRunState>()
const processes = new Map<string, ChildProcess>()
const logs = new Map<string, string[]>()
/** epoch ms when each running instance's game process started, for playtime tracking */
const startedAt = new Map<string, number>()

/** Buffered log broadcast so a chatty game process doesn't flood IPC. */
const pendingLogs = new Map<string, string[]>()
let logFlushTimer: NodeJS.Timeout | null = null

export function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send(channel, payload)
  }
}

function setState(instanceId: string, state: InstanceRunState, extra?: Partial<GameStateEvent>): void {
  states.set(instanceId, state)
  broadcast('game:state', { instanceId, state, ...extra } satisfies GameStateEvent)
}

export function emitProgress(instanceId: string, phase: string, progress: number): void {
  broadcast('game:progress', { instanceId, phase, progress } satisfies ProgressEvent)
}

/** Used by long-running non-launch operations (modpack import/update) to reuse the install UI. */
export function setInstallingState(instanceId: string, installing: boolean): void {
  setState(instanceId, installing ? 'installing' : 'idle')
}

function pushLog(instanceId: string, line: string): void {
  const buffer = logs.get(instanceId) ?? []
  buffer.push(line)
  if (buffer.length > MAX_LOG_LINES) buffer.splice(0, buffer.length - MAX_LOG_LINES)
  logs.set(instanceId, buffer)

  const pending = pendingLogs.get(instanceId) ?? []
  pending.push(line)
  pendingLogs.set(instanceId, pending)
  if (!logFlushTimer) {
    logFlushTimer = setTimeout(() => {
      logFlushTimer = null
      for (const [id, lines] of pendingLogs) {
        broadcast('game:log', { instanceId: id, line: lines.join('\n') } satisfies GameLogEvent)
      }
      pendingLogs.clear()
    }, 250)
  }
}

export function getRunStates(): Record<string, InstanceRunState> {
  return Object.fromEntries(states)
}

export function getLogs(instanceId: string): string[] {
  return logs.get(instanceId) ?? []
}

export function killGame(instanceId: string): void {
  processes.get(instanceId)?.kill()
}

/** Run the heavy install pipeline in a utilityProcess so the UI stays responsive. */
function runInstallWorker(instance: Instance): Promise<{ versionId: string; javaPath: string }> {
  const job: InstallJob = {
    instanceId: instance.id,
    minecraftVersion: instance.minecraftVersion,
    loader: instance.loader,
    loaderVersion: instance.loaderVersion,
    sharedDir,
    javaDir,
    instanceDir: instanceDir(instance.id)
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const worker = utilityProcess.fork(join(__dirname, 'installWorker.js'), [], {
      serviceName: `elauncher-install-${instance.id}`
    })
    let settled = false
    const finish = (fn: () => void): void => {
      if (!settled) {
        settled = true
        fn()
        worker.kill()
      }
    }
    worker.on('message', (msg: WorkerMessage) => {
      if (msg.type === 'progress') {
        emitProgress(instance.id, msg.phase, msg.progress)
      } else if (msg.type === 'done') {
        finish(() => resolvePromise({ versionId: msg.versionId, javaPath: msg.javaPath }))
      } else if (msg.type === 'error') {
        finish(() => rejectPromise(new Error(msg.message)))
      }
    })
    worker.on('exit', (code) => {
      finish(() => rejectPromise(new Error(`Install worker exited unexpectedly (code ${code})`)))
    })
    worker.postMessage(job)
  })
}

export async function launchInstance(instanceId: string): Promise<void> {
  if (states.get(instanceId) === 'installing' || states.get(instanceId) === 'running') {
    throw new Error('This instance is already running or installing.')
  }
  const instance = getInstance(instanceId)
  const settings = getSettings()

  logs.set(instanceId, [])
  setState(instanceId, 'installing')
  try {
    const session = await getActiveSession()
    pushLog(instanceId, `[ELauncher] Logged in as ${session.name}`)

    const { versionId, javaPath } = await runInstallWorker(instance)
    const resolved = await Version.parse(sharedDir, versionId)

    // memory: explicit per-instance value > auto-sizing from system RAM > global default
    let memory: number
    if (instance.memoryMax > 0) {
      memory = instance.memoryMax
    } else if (settings.autoMemory) {
      memory = autoMemoryMiB(instance.loader)
      pushLog(instanceId, `[ELauncher] Auto memory: ${memory} MiB (based on system RAM)`)
    } else {
      memory = settings.defaultMemoryMax
    }

    const javaOverride = instance.javaPathOverride || settings.javaPath
    const userJvm = (instance.extraJvmArgs ?? '').split(/\s+/).filter(Boolean)

    // Tuned GC flags reduce stutter a lot on modded packs. Skipped when the user
    // picked a collector themselves, since mixing GC flags fails at startup.
    const userPicksGc = userJvm.some((a) => /-XX:\+Use(G1|Z|Shenandoah|Parallel|Serial|Epsilon)GC/.test(a))
    const useOptimized = Boolean(settings.optimizedJvmFlags) && !userPicksGc
    let extraJvm = userJvm
    if (useOptimized) {
      const { gc, flags } = optimizedFlagsFor(resolved.javaVersion?.majorVersion, settings.jvmGc ?? 'auto')
      extraJvm = [...flags, ...userJvm]
      pushLog(
        instanceId,
        gc === 'zgc'
          ? '[ELauncher] Performance: generational ZGC enabled (sub-ms GC pauses, Java 21+)'
          : "[ELauncher] Performance: Aikar's G1 tuning enabled"
      )
    }

    emitProgress(instanceId, 'Starting game', -1)
    pushLog(instanceId, `[ELauncher] Launching ${resolved.id}`)

    const proc = await launch({
      gamePath: instanceDir(instance.id),
      resourcePath: sharedDir,
      javaPath: javaOverride || javaPath,
      version: resolved,
      accessToken: session.accessToken,
      gameProfile: { name: session.name, id: session.uuid },
      maxMemory: memory,
      // pre-allocating the whole heap (with AlwaysPreTouch) avoids GC resize stutter
      minMemory: useOptimized ? memory : undefined,
      extraJVMArgs: extraJvm.length > 0 ? extraJvm : undefined,
      launcherName: 'ELauncher',
      launcherBrand: 'elauncher',
      // keep the game alive if the launcher exits or hot-reloads
      extraExecOption: { detached: true }
    })

    processes.set(instanceId, proc)
    touchLastPlayed(instanceId)
    startedAt.set(instanceId, Date.now())

    if (settings.highProcessPriority && raisePriority(proc.pid)) {
      pushLog(instanceId, '[ELauncher] Performance: game process priority raised to above-normal')
    }

    proc.stdout?.setEncoding('utf-8')
    proc.stderr?.setEncoding('utf-8')
    proc.stdout?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line) pushLog(instanceId, line)
    })
    proc.stderr?.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line) pushLog(instanceId, line)
    })

    const recordPlaytime = (): void => {
      const started = startedAt.get(instanceId)
      if (started) {
        startedAt.delete(instanceId)
        addPlaytime(instanceId, Date.now() - started)
      }
    }

    const watcher = createMinecraftProcessWatcher(proc)
    watcher.on('error', (err) => {
      pushLog(instanceId, `[ELauncher] Failed to start game: ${err}`)
      processes.delete(instanceId)
      recordPlaytime()
      setState(instanceId, 'idle', { crashed: true, error: String(err) })
    })
    watcher.on('minecraft-exit', ({ code, crashReport, crashReportLocation }) => {
      processes.delete(instanceId)
      recordPlaytime()
      const crashed = code !== 0
      if (crashed) {
        pushLog(instanceId, `[ELauncher] Game exited with code ${code}`)
        if (crashReportLocation) pushLog(instanceId, `[ELauncher] Crash report: ${crashReportLocation}`)
        if (crashReport) pushLog(instanceId, crashReport)
      } else {
        pushLog(instanceId, '[ELauncher] Game exited normally')
      }
      setState(instanceId, 'idle', { crashed, exitCode: code })
    })

    setState(instanceId, 'running')
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    pushLog(instanceId, `[ELauncher] Error: ${message}`)
    setState(instanceId, 'idle', { crashed: true, error: message })
    throw new Error(message)
  }
}
