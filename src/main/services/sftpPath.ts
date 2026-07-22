import { realpathSync } from 'fs'
import { dirname, isAbsolute, join, resolve, sep } from 'path'

/**
 * Confining an SFTP session to one server's folder.
 *
 * This is the whole security boundary of the file-transfer feature. Every path
 * a client sends arrives as an untrusted string, and several customers' worlds
 * sit side by side under the same servers/ directory — a path that escapes its
 * root does not fail safe, it hands one customer another's files.
 *
 * Split into its own module so it can be reasoned about, and tested, without an
 * SSH server in the way.
 */

/** True when `child` is `root` itself or genuinely underneath it. */
function contains(root: string, child: string): boolean {
  if (child === root) return true
  // the separator matters: /srv/data-evil must not pass as inside /srv/data
  return child.startsWith(root.endsWith(sep) ? root : root + sep)
}

/**
 * Resolve a client-supplied path against a server's root, or return null.
 *
 * Null means refuse. Callers must translate that into a permission error and
 * never fall back to the raw path.
 */
export function resolveInRoot(root: string, requested: string): string | null {
  // A client may send '/mods', 'mods', './mods' or a Windows-style path. The
  // leading slash is the SFTP client's idea of "the root you gave me", not the
  // filesystem root, so it is stripped rather than honoured.
  const cleaned = String(requested ?? '').replace(/\\/g, '/').replace(/^\/+/, '')
  if (cleaned.includes('\0')) return null

  const rootAbs = resolve(root)
  const target = resolve(rootAbs, cleaned)

  // Cheap check first: catches ../ climbing before any filesystem work.
  if (!contains(rootAbs, target)) return null

  // Then the expensive, honest one. A symlink inside the folder can point
  // anywhere, so lexical containment is not enough — resolve links and ask
  // again. The root itself is resolved too, or a host whose data dir is reached
  // through a link would fail every comparison.
  let realRoot: string
  try {
    realRoot = realpathSync(rootAbs)
  } catch {
    // the server folder is missing; nothing inside it can be served
    return null
  }

  try {
    const realTarget = realpathSync(target)
    return contains(realRoot, realTarget) ? realTarget : null
  } catch {
    // The target does not exist yet, which is normal — an upload or mkdir names
    // something new. Its PARENT must already be inside the root, otherwise a
    // client could create a file through a symlinked directory.
    const parent = dirname(target)
    try {
      const realParent = realpathSync(parent)
      if (!contains(realRoot, realParent)) return null
      // rebuild from the resolved parent so the returned path has no links left
      return join(realParent, target.slice(parent.length + 1))
    } catch {
      return null
    }
  }
}

/**
 * The path to report back to the client for a real path on disk.
 *
 * Clients show this and build later requests from it, so it has to be the
 * jailed view ('/mods'), never the host's actual location — which would leak
 * the directory layout and the operator's username.
 */
export function toClientPath(root: string, absolute: string): string {
  const rootAbs = resolve(root)
  if (!isAbsolute(absolute)) return '/'
  const rel = absolute === rootAbs ? '' : absolute.slice(rootAbs.length).replace(/\\/g, '/')
  return `/${rel.replace(/^\/+/, '')}`.replace(/\/+$/, '') || '/'
}
