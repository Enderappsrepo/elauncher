// Adversarial test for the SFTP path jail in src/main/services/sftpPath.ts.
//
// That module is the entire security boundary of per-customer file access:
// several customers' worlds sit side by side under servers/, so a path that
// escapes its root hands one customer another's files. Every case below is
// something a hostile client can actually put on the wire.
//
// It compiles and exercises the real module rather than restating its logic —
// a copy of the rules here would pass forever while the shipped ones rotted.
//
// Usage: node scripts/smoke-sftp-jail.mjs
import { execFileSync } from 'child_process'
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import os from 'os'

const ROOT = resolve(import.meta.dirname, '..')
const work = join(os.tmpdir(), `elauncher-sftp-jail-${process.pid}`)
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })

// the compiler is invoked through node rather than the npx shim: spawning a
// .cmd without a shell fails outright on Windows, and enabling one just to
// launch a build step is not worth the quoting risk
execFileSync(
  process.execPath,
  [join(ROOT, 'node_modules/typescript/bin/tsc'),
   join(ROOT, 'src/main/services/sftpPath.ts'), '--ignoreConfig',
   // --ignoreConfig also drops the node typings the module's fs/path imports need
   '--outDir', join(work, 'lib'), '--module', 'commonjs', '--target', 'es2022', '--types', 'node'],
  { cwd: ROOT, stdio: 'inherit' }
)
const { resolveInRoot, toClientPath } = await import(
  pathToFileURL(join(work, 'lib', 'sftpPath.js')).href
)

// two customers side by side, exactly as servers/<id> lays them out
const victim = join(work, 'servers', 'victim')
const root = join(work, 'servers', 'mine')
mkdirSync(join(root, 'mods'), { recursive: true })
mkdirSync(victim, { recursive: true })
writeFileSync(join(victim, 'secret.txt'), 'another customer world')
writeFileSync(join(root, 'mods', 'ok.jar'), 'x')

// a sibling whose name merely starts with the root's — the classic prefix bug
mkdirSync(root + '-evil', { recursive: true })
writeFileSync(join(root + '-evil', 'loot.txt'), 'nope')

// planted inside the jail: the case lexical containment cannot catch
let symlinks = true
try {
  symlinkSync(victim, join(root, 'escape'), 'dir')
  symlinkSync(join(victim, 'secret.txt'), join(root, 'secret-link'), 'file')
} catch {
  symlinks = false // unprivileged Windows cannot create them
}

let failed = 0
const refuse = (label, path) => {
  const got = resolveInRoot(root, path)
  if (got !== null) {
    failed++
    console.log(`  FAIL  ${label} -> ${got}`)
  } else console.log(`  ok    ${label}`)
}
const allow = (label, path) => {
  const got = resolveInRoot(root, path)
  if (got === null) {
    failed++
    console.log(`  FAIL  ${label} -> refused`)
  } else console.log(`  ok    ${label}`)
}

console.log('escapes (must refuse):')
refuse('../victim', '../victim')
refuse('/../victim', '/../victim')
refuse('mods/../../victim', 'mods/../../victim')
refuse('....//victim', '....//victim')
refuse('backslash climb', '..\\victim')
refuse('mixed separators', 'mods\\..\\..\\victim')
refuse('null byte', 'mods/ok.jar\0.txt')
refuse('sibling prefix', '../mine-evil/loot.txt')
refuse('deep climb', '../../../../../../etc/passwd')
if (symlinks) {
  refuse('symlinked dir', 'escape')
  refuse('read through symlink', 'escape/secret.txt')
  refuse('symlinked file', 'secret-link')
  refuse('create through symlink', 'escape/planted.txt')
} else console.log('  (symlink cases skipped: not permitted on this host)')

console.log('legitimate use (must allow):')
allow('root', '/')
allow('empty', '')
allow('subdir', 'mods')
allow('file', '/mods/ok.jar')
allow('dot-slash', './mods')
allow('new upload', '/mods/new.jar')
allow('new subdir', 'mods/sub')
allow('climb back inside', 'mods/../mods/ok.jar')

console.log('client-facing paths (must not leak the host layout):')
const shown = [root, join(root, 'mods'), join(root, 'mods', 'ok.jar')].map((p) => toClientPath(root, p))
console.log('  ', JSON.stringify(shown))
if (shown.some((p) => p.includes('servers') || p.includes('Temp') || p.includes('tmp'))) {
  failed++
  console.log('  FAIL  a client path exposed the real location')
}

rmSync(work, { recursive: true, force: true })
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} FAILURE(S)`)
process.exit(failed === 0 ? 0 : 1)
