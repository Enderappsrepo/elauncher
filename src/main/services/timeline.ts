import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { ServerTimeline, TimelineEventKind, TimelineSample } from '@shared/types'

/**
 * A rolling record of what a server was doing, so a crash can be traced to what
 * led up to it instead of guessed at from the tail of a log.
 *
 * Two streams, deliberately: cheap numeric samples on a fixed cadence, and rare
 * labelled events. Reading "memory climbed for an hour, then an OOM restart" off
 * one timeline is the whole point — either stream alone leaves you guessing.
 *
 * Kept on disk beside the server so it survives a launcher restart, and capped
 * so a server left running for months cannot grow an unbounded file.
 */

/** ~24h at one sample a minute. Old samples fall off the front. */
const MAX_SAMPLES = 1440
const MAX_EVENTS = 200

const EMPTY: ServerTimeline = { samples: [], events: [] }

const filePath = (dir: string): string => join(dir, 'elauncher-timeline.json')

export function readTimeline(dir: string): ServerTimeline {
  const file = filePath(dir)
  if (!existsSync(file)) return { samples: [], events: [] }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<ServerTimeline>
    return {
      samples: Array.isArray(parsed.samples) ? parsed.samples : [],
      events: Array.isArray(parsed.events) ? parsed.events : []
    }
  } catch {
    // a truncated file (killed mid-write) is not worth failing a page load over
    return { samples: [], events: [] }
  }
}

function write(dir: string, data: ServerTimeline): void {
  try {
    mkdirSync(dirname(filePath(dir)), { recursive: true })
    writeFileSync(filePath(dir), JSON.stringify(data), 'utf-8')
  } catch {
    // a timeline is diagnostics; losing a write must never break the server
  }
}

/**
 * Writes are batched in memory and flushed on a timer, because a sample a minute
 * per server would otherwise be a disk write a minute per server forever.
 */
const pending = new Map<string, ServerTimeline>()

function load(dir: string): ServerTimeline {
  let held = pending.get(dir)
  if (!held) {
    held = readTimeline(dir)
    pending.set(dir, held)
  }
  return held
}

export function addSample(dir: string, sample: TimelineSample): void {
  const held = load(dir)
  held.samples.push(sample)
  if (held.samples.length > MAX_SAMPLES) held.samples.splice(0, held.samples.length - MAX_SAMPLES)
}

export function addEvent(dir: string, kind: TimelineEventKind, detail: string): void {
  const held = load(dir)
  held.events.push({ t: Date.now(), kind, detail })
  if (held.events.length > MAX_EVENTS) held.events.splice(0, held.events.length - MAX_EVENTS)
  // events are the rare, interesting half — never risk losing one to a crash
  write(dir, held)
}

/** Flush every dirty timeline. Called on a timer and at shutdown. */
export function flushTimelines(): void {
  for (const [dir, data] of pending) write(dir, data)
}

/** Forget a deleted server's buffer so it can't be rewritten after removal. */
export function forgetTimeline(dir: string): void {
  pending.delete(dir)
}

export { EMPTY as EMPTY_TIMELINE }
