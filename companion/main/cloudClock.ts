/**
 * The cloud's clock, as the Date header of its latest answer gives it.
 *
 * Hosts stamp server_status.updated_at with their own clock every few seconds, and the cloud keeps the
 * value as sent. Judging that heartbeat against this PC's clock compares two machines' clocks, so a PC
 * clock running a minute fast would make every host look offline. Measured against the cloud's time
 * instead, only the host's own clock matters, as it does for the panel's "PC offline" badge. The header
 * has one-second resolution, plenty for a 60-second window. Until the cloud has answered once, this is
 * the PC's own clock.
 */
let offsetMs = 0

/** Record the cloud's time from a response's Date header; anything unreadable is ignored. */
export function noteServerDate(header: string | null | undefined, localNow = Date.now()): void {
  if (!header) return
  const at = Date.parse(header)
  if (Number.isFinite(at)) offsetMs = at - localNow
}

/** Now, by the cloud's clock. */
export function cloudNow(localNow = Date.now()): number {
  return localNow + offsetMs
}

/** fetch for the Supabase client: every answer from the cloud also sets the clock. */
export const clockedFetch: typeof fetch = async (input, init) => {
  const response = await fetch(input, init)
  noteServerDate(response.headers.get('date'))
  return response
}
