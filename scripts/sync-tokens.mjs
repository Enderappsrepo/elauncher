// Splices src/shared/tokens.css into the single-file pages under docs/.
//
// The Electron renderer @imports tokens.css directly, but the two docs/ pages
// are zero-build static files served from GitHub Pages — they can't import
// anything without a bundler, and inlining keeps them to one atomic cache
// entry for the service worker. So they carry a generated copy instead.
//
//   npm run sync:tokens          rewrite the generated blocks
//   npm run sync:tokens -- --check   fail if any block is stale (CI / pre-commit)
//
// Each target marks its block with:
//   /* <tokens:begin> ... */  ...generated...  /* <tokens:end> */

import { readFile, writeFile } from 'fs/promises'
import { fileURLToPath } from 'url'
import { dirname, join, relative } from 'path'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SOURCE = join(ROOT, 'src/shared/tokens.css')

const TARGETS = [
  { file: 'docs/manage/index.html', indent: '    ' },
  { file: 'docs/index.html', indent: '    ' }
]

const BEGIN = '/* <tokens:begin>'
const END = '/* <tokens:end> */'
const check = process.argv.includes('--check')

/** Strip the source file's header comment — the generated copies get their own. */
function body(css) {
  return css.replace(/^\s*\/\*[\s\S]*?\*\/\s*/, '').trimEnd()
}

function block(css, indent) {
  const head =
    `${BEGIN} generated from src/shared/tokens.css — do not edit by hand.\n` +
    `   Edit that file, then run: npm run sync:tokens */`
  const lines = [...head.split('\n'), ...body(css).split('\n'), END]
  // don't indent blank lines; trailing whitespace churns the diff for nothing
  return lines.map((l) => (l.trim() ? indent + l : '')).join('\n').trim()
}

const css = await readFile(SOURCE, 'utf8')
let stale = 0
let wrote = 0

for (const { file, indent } of TARGETS) {
  const path = join(ROOT, file)
  let html
  try {
    html = await readFile(path, 'utf8')
  } catch {
    console.error(`✗ ${file} — not found`)
    process.exitCode = 1
    continue
  }

  const start = html.indexOf(BEGIN)
  const finish = html.indexOf(END)
  if (start === -1 || finish === -1 || finish < start) {
    console.error(
      `✗ ${file} — missing markers.\n` +
        `  Wrap the :root token block with:\n` +
        `    ${BEGIN} ... */\n    ${END}`
    )
    process.exitCode = 1
    continue
  }

  const current = html.slice(start, finish + END.length)
  const next = block(css, indent)
  if (current === next) {
    console.log(`  ${file} — up to date`)
    continue
  }

  if (check) {
    console.error(`✗ ${file} — stale, run: npm run sync:tokens`)
    stale++
    continue
  }

  await writeFile(path, html.slice(0, start) + next + html.slice(finish + END.length))
  console.log(`✓ ${file} — updated`)
  wrote++
}

if (check && stale) process.exitCode = 1
else if (!check) console.log(`\ntokens synced from ${relative(ROOT, SOURCE)} — ${wrote} file(s) rewritten`)
