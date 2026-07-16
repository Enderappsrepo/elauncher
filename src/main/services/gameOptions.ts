import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { GameOptions } from '@shared/types'
import { instanceDir } from '../paths'

function optionsFile(instanceId: string): string {
  return join(instanceDir(instanceId), 'options.txt')
}

/** Reads options.txt as raw key -> value entries (values keep their quoting as-is). */
export function getGameOptions(instanceId: string): GameOptions {
  const file = optionsFile(instanceId)
  if (!existsSync(file)) return { exists: false, entries: {} }
  const entries: Record<string, string> = {}
  for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
    const idx = line.indexOf(':')
    if (idx <= 0) continue
    entries[line.slice(0, idx)] = line.slice(idx + 1)
  }
  return { exists: true, entries }
}

/**
 * Merge-writes the given entries into options.txt, preserving the order of
 * existing lines and any keys we don't touch. Missing keys are appended so the
 * settings apply even before the game has created the file.
 */
export function setGameOptions(instanceId: string, updates: Record<string, string>): GameOptions {
  const file = optionsFile(instanceId)
  const pending = new Map(Object.entries(updates))
  const lines: string[] = []

  if (existsSync(file)) {
    for (const line of readFileSync(file, 'utf-8').split(/\r?\n/)) {
      const idx = line.indexOf(':')
      const key = idx > 0 ? line.slice(0, idx) : null
      if (key && pending.has(key)) {
        lines.push(`${key}:${pending.get(key)}`)
        pending.delete(key)
      } else if (line.trim().length > 0) {
        lines.push(line)
      }
    }
  }
  for (const [key, value] of pending) {
    lines.push(`${key}:${value}`)
  }
  writeFileSync(file, lines.join('\n') + '\n', 'utf-8')
  return getGameOptions(instanceId)
}
