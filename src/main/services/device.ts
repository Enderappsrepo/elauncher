import { randomUUID } from 'crypto'
import { deviceFile } from '../paths'
import { readJson, writeJson } from '../store'

/**
 * This machine's identity in the hosting fleet. Several boxes can be signed
 * into one hosting account — a desktop launcher plus one or more VPS hosts —
 * and the cloud has to tell them apart: which box claimed an order, which
 * box a fleet health card belongs to. The account id can't do that; it's the
 * same on all of them. Generated once and kept with the rest of the data.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

let cached: string | null = null

export function deviceId(): string {
  if (cached) return cached
  const stored = readJson<{ id?: string }>(deviceFile, {}).id
  // the id is interpolated into cloud filter strings, so a truncated or
  // hand-edited file must never reach the wire — regenerate instead
  cached = stored && UUID.test(stored) ? stored : randomUUID()
  if (cached !== stored) writeJson(deviceFile, { id: cached })
  return cached
}
