/**
 * Headless-host awareness for the service layer. On a VPS there is no window
 * and no renderer attached, so activity that normally lands in the UI is
 * mirrored to stdout — journalctl becomes the box's logbook.
 */
export const HEADLESS = process.env.ELAUNCHER_HEADLESS === '1' || process.argv.includes('--headless')

/** Set ELAUNCHER_LOG_CONSOLE=1 to also mirror full game-server console output (verbose). */
export const LOG_CONSOLE = HEADLESS && process.env.ELAUNCHER_LOG_CONSOLE === '1'

/**
 * Whether this box provisions paid hosting orders. Headless hosts do — that is
 * what they exist for; a desktop launcher does not, so opening the launcher at
 * home can't race the VPS into building the same customer's server twice. Set
 * ELAUNCHER_HOSTING_NODE=1 to make a desktop provision anyway, or =0 to stand a
 * headless box down. Hosting a server yourself is unaffected either way — this
 * gates the order provisioner only.
 */
export const HOSTING_NODE =
  process.env.ELAUNCHER_HOSTING_NODE === '1' ||
  (HEADLESS && process.env.ELAUNCHER_HOSTING_NODE !== '0')

/** Log a line to the service journal on headless hosts; no-op in the desktop app. */
export function headlessLog(line: string): void {
  if (HEADLESS) console.log(line)
}
