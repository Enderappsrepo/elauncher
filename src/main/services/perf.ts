import os from 'os'
import type { ModLoader } from '@shared/types'

/**
 * Aikar's flags: the de-facto standard G1 GC tuning for (modded) Minecraft.
 * Greatly reduces GC stutter compared to the JVM defaults.
 * https://docs.papermc.io/paper/aikars-flags
 */
const G1_FLAGS = [
  '-XX:+UseG1GC',
  '-XX:+ParallelRefProcEnabled',
  '-XX:MaxGCPauseMillis=200',
  '-XX:+UnlockExperimentalVMOptions',
  '-XX:+DisableExplicitGC',
  '-XX:+AlwaysPreTouch',
  '-XX:G1NewSizePercent=30',
  '-XX:G1MaxNewSizePercent=40',
  '-XX:G1HeapRegionSize=8M',
  '-XX:G1ReservePercent=20',
  '-XX:G1HeapWastePercent=5',
  '-XX:G1MixedGCCountTarget=4',
  '-XX:InitiatingHeapOccupancyPercent=15',
  '-XX:G1MixedGCLiveThresholdPercent=90',
  '-XX:G1RSetUpdatingPauseTimePercent=5',
  '-XX:SurvivorRatio=32',
  '-XX:+PerfDisableSharedMem',
  '-XX:MaxTenuringThreshold=1'
]

/**
 * Generational ZGC: fully concurrent collector with sub-millisecond pauses.
 * Noticeably smoother than G1 for mods doing heavy background work
 * (e.g. Distant Horizons explicitly recommends it). Requires Java 21+.
 * The ZGenerational flag is ignored with a warning on Java 24+, where
 * generational mode is already the default.
 */
const ZGC_FLAGS = [
  '-XX:+UseZGC',
  '-XX:+ZGenerational',
  '-XX:+AlwaysPreTouch',
  '-XX:+DisableExplicitGC',
  '-XX:+PerfDisableSharedMem'
]

export type GcMode = 'auto' | 'g1' | 'zgc'

/** Pick the tuned flag set for the runtime: ZGC when available (Java 21+), else Aikar's G1. */
export function optimizedFlagsFor(javaMajor: number | undefined, mode: GcMode): { gc: 'g1' | 'zgc'; flags: string[] } {
  const zgcSupported = (javaMajor ?? 0) >= 21
  if (mode === 'zgc' || (mode === 'auto' && zgcSupported)) {
    return { gc: 'zgc', flags: ZGC_FLAGS }
  }
  return { gc: 'g1', flags: G1_FLAGS }
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/**
 * Pick a sensible max heap (MiB) from the machine's RAM.
 * Modded packs want more headroom than vanilla; always leave the OS at least 2 GiB.
 */
export function autoMemoryMiB(loader: ModLoader): number {
  const totalMiB = Math.floor(os.totalmem() / 1024 / 1024)
  const budget = Math.max(totalMiB - 2048, 1024)
  const wanted =
    loader === 'vanilla'
      ? clamp(Math.floor(totalMiB / 4), 2048, 4096)
      : clamp(Math.floor(totalMiB / 2), 4096, 8192)
  return Math.min(wanted, budget)
}

/** Raise the game process to above-normal priority (best effort). */
export function raisePriority(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    os.setPriority(pid, os.constants.priority.PRIORITY_ABOVE_NORMAL)
    return true
  } catch {
    return false
  }
}
