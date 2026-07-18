/**
 * Headless-host awareness for the service layer. On a VPS there is no window
 * and no renderer attached, so activity that normally lands in the UI is
 * mirrored to stdout — journalctl becomes the box's logbook.
 */
export const HEADLESS = process.env.ELAUNCHER_HEADLESS === '1' || process.argv.includes('--headless')

/** Set ELAUNCHER_LOG_CONSOLE=1 to also mirror full game-server console output (verbose). */
export const LOG_CONSOLE = HEADLESS && process.env.ELAUNCHER_LOG_CONSOLE === '1'

/** Log a line to the service journal on headless hosts; no-op in the desktop app. */
export function headlessLog(line: string): void {
  if (HEADLESS) console.log(line)
}
