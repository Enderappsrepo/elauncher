// Nothing links to the companion until the latest release is seen to carry it. When GitHub's API
// cannot tell (unreachable, rate-limited, not answering), the landing links to the releases list instead.
//   node --import ./scripts/companion-links/hooks.mjs --test scripts/companion-links/test-companion-link.mjs
//   (WEB_SRC=<dir> checks another copy of web/src)
// Runs the real useRelease / useCompanionDownload hooks (TypeScript, via Node's type stripping) with a
// stubbed fetch and a minimal React, and checks the panel/landing markup at source level.
import { test, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mount } from './fake-react.mjs'

const WEB = process.env.WEB_SRC ?? fileURLToPath(new URL('../../web/src', import.meta.url))
const load = async (rel) => import(pathToFileURL(`${WEB}/${rel}`).href)
const { useRelease, COMPANION_LOOKUP_PATIENCE_MS: PATIENCE } = await load('landing/useRelease.ts')
const lib = await load('lib/companion.ts')
const RELEASES_LIST = 'https://github.com/Enderappsrepo/elauncher/releases'

const LAUNCHER = [
  { name: 'ELauncher-Setup-0.1.5.exe', size: 90 * 1048576, browser_download_url: 'https://github.com/o/r/releases/download/v0.1.5/ELauncher-Setup-0.1.5.exe' },
  { name: 'ELauncher-Portable-0.1.5.exe', size: 90 * 1048576, browser_download_url: 'https://github.com/o/r/releases/download/v0.1.5/ELauncher-Portable-0.1.5.exe' },
  { name: 'latest.yml', size: 400, browser_download_url: 'https://github.com/o/r/releases/download/v0.1.5/latest.yml' }
]
const COMPANION = { name: 'ELauncher-NVMP-Companion.exe', size: 133 * 1048576, browser_download_url: 'https://github.com/o/r/releases/download/v0.1.5/ELauncher-NVMP-Companion.exe' }

let answer
let calls
beforeEach(() => {
  calls = []
  globalThis.fetch = async (url) => {
    calls.push(String(url))
    return answer()
  }
})
afterEach(() => mock.timers.reset())
const release = (assets) => () => ({ ok: true, json: async () => ({ tag_name: 'v0.1.5', assets }) })
const settle = () => new Promise((r) => setImmediate(r))
/** A fetch answer the test resolves later. */
function deferred() {
  let resolve
  const promise = new Promise((r) => (resolve = r))
  return { answer: () => promise, resolve: (v) => resolve(v) }
}

/** No value anywhere in the hook's result may be a blind latest/download link or point at the asset unverified. */
function assertNoBlindLink(value, verified = null) {
  const text = JSON.stringify(value)
  assert.ok(!/releases\/latest\/download/.test(text), `blind latest/download link in ${text}`)
  for (const m of text.matchAll(/https?:[^"]*ELauncher-NVMP-Companion\.exe/g)) assert.equal(m[0], verified, `unverified companion link ${m[0]}`)
}

test('companionDownload: only the exact asset name counts', () => {
  assert.equal(lib.companionDownload(undefined), 'missing')
  assert.equal(lib.companionDownload([]), 'missing')
  assert.equal(lib.companionDownload(LAUNCHER), 'missing')
  assert.equal(lib.companionDownload([{ ...COMPANION, name: 'ELauncher-NVMP-Companion.exe.blockmap' }]), 'missing')
  assert.equal(lib.companionDownload([{ ...COMPANION, name: 'ELauncher-NVMP-Companion-0.1.5.exe' }]), 'missing')
  assert.deepEqual(lib.companionDownload([...LAUNCHER, COMPANION]), { url: COMPANION.browser_download_url, size: '133 MB' })
  // GitHub lists an asset while it uploads ('open') and after a failed upload ('starter'); its URL is a 404 until 'uploaded'
  assert.equal(lib.companionDownload([...LAUNCHER, { ...COMPANION, state: 'open' }]), 'missing')
  assert.equal(lib.companionDownload([...LAUNCHER, { ...COMPANION, state: 'starter' }]), 'missing')
  assert.deepEqual(lib.companionDownload([...LAUNCHER, { ...COMPANION, state: 'uploaded' }]), { url: COMPANION.browser_download_url, size: '133 MB' })
  assert.ok(!Object.values(lib).some((v) => typeof v === 'string' && /latest\/download/.test(v)), 'lib still exports a blind link')
})

test('landing: before the API answers there is no companion link', () => {
  answer = () => new Promise(() => {})
  const h = mount(useRelease)
  assertNoBlindLink(h.first)
  assert.equal(h.first.companion, null)
  h.unmount()
})

test('landing: a latest release without the companion says "missing", with no link', async () => {
  answer = release(LAUNCHER)
  const h = mount(useRelease)
  await settle()
  const r = h.current()
  assert.equal(r.setupUrl, LAUNCHER[0].browser_download_url, 'launcher lookup still works')
  assertNoBlindLink(r)
  assert.equal(r.companion, 'missing')
})

test('landing: a latest release with the companion links to that exact asset', async () => {
  answer = release([...LAUNCHER, COMPANION])
  const h = mount(useRelease)
  await settle()
  const r = h.current()
  assert.deepEqual(r.companion, { url: COMPANION.browser_download_url, size: '133 MB' })
  assertNoBlindLink(r, COMPANION.browser_download_url)
})

test('landing: a rate-limited or unreachable API gives "unknown" (the releases list), never an asset link', async () => {
  const failures = [
    () => ({ ok: false, status: 403, json: async () => ({ message: 'API rate limit exceeded' }) }),
    () => ({ ok: false, status: 429, json: async () => ({}) }),
    () => Promise.reject(new TypeError('Failed to fetch')),
    () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON') } })
  ]
  for (const a of failures) {
    answer = a
    const h = mount(useRelease)
    await settle()
    const r = h.current()
    assertNoBlindLink(r)
    assert.equal(r.companion, 'unknown')
    // the launcher buttons keep their own fallback
    assert.equal(r.setupUrl, 'https://github.com/Enderappsrepo/elauncher/releases/latest')
    h.unmount()
  }
})

test('landing: an API that does not answer gives "unknown" after the patience, and a late answer still wins', async () => {
  assert.equal(typeof PATIENCE, 'number', 'useRelease exports COMPANION_LOOKUP_PATIENCE_MS')
  mock.timers.enable({ apis: ['setTimeout'] })
  const late = deferred()
  answer = late.answer
  const h = mount(useRelease)
  mock.timers.tick(PATIENCE - 1)
  assert.equal(h.current().companion, null, 'still looking')
  mock.timers.tick(1)
  assert.equal(h.current().companion, 'unknown')
  assertNoBlindLink(h.current())
  late.resolve(release([...LAUNCHER, COMPANION])())
  await settle()
  assert.deepEqual(h.current().companion, { url: COMPANION.browser_download_url, size: '133 MB' })
  h.unmount()
})

test('landing: a settled lookup is never turned into "unknown" later', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  for (const [a, want] of [[release(LAUNCHER), 'missing'], [release([...LAUNCHER, COMPANION]), { url: COMPANION.browser_download_url, size: '133 MB' }]]) {
    answer = a
    const h = mount(useRelease)
    await settle()
    mock.timers.tick(PATIENCE * 2)
    assert.deepEqual(h.current().companion, want)
    h.unmount()
  }
})

test('landing: unmounting stops the patience timer', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  answer = deferred().answer
  const h = mount(useRelease)
  h.unmount()
  mock.timers.tick(PATIENCE * 2)
  assert.equal(h.current().companion, null)
})

test('panel hook: the verified download when the latest release carries the companion, the releases list when the lookup fails', async () => {
  const cases = [
    [release(LAUNCHER), null], // nothing to offer yet
    [release([...LAUNCHER, COMPANION]), { url: COMPANION.browser_download_url, size: '133 MB' }],
    [() => ({ ok: false, status: 403, json: async () => ({}) }), 'releases'], // rate-limited
    [() => Promise.reject(new TypeError('offline')), 'releases'],
    [() => ({ ok: true, json: async () => { throw new SyntaxError('not JSON') } }), 'releases']
  ]
  for (const [a, want] of cases) {
    answer = a
    const h = mount(lib.useCompanionDownload)
    assert.equal(h.first, null, 'nothing while the lookup runs')
    await settle()
    assert.deepEqual(h.current(), want)
    assertNoBlindLink(h.current(), want?.url ?? null)
    assert.match(calls.at(-1), /api\.github\.com\/repos\/Enderappsrepo\/elauncher\/releases\/latest$/)
    h.unmount()
  }
  // an answer arriving after the tab closed sets nothing
  const late = deferred()
  answer = late.answer
  const h = mount(lib.useCompanionDownload)
  h.unmount()
  late.resolve(release([...LAUNCHER, COMPANION])())
  await settle()
  assert.equal(h.current(), null)
})

test('panel and landing markup use the verified link only', () => {
  const setup = readFileSync(`${WEB}/panel/tabs/NvmpSetup.tsx`, 'utf8')
  assert.ok(!/COMPANION_URL|latest\/download/.test(setup))
  assert.match(setup, /const companion = useCompanionDownload\(\)/)
  // the card: GitHub's releases list when the lookup failed, otherwise the verified asset; nothing else
  const card = setup.slice(setup.indexOf('{companion && <div className="companion-offer'), setup.indexOf('{companion && <p><b>Or upload from this browser</b>'))
  assert.ok(card.length > 0, 'the companion card is in the NV:MP setup tab')
  assert.match(card, /companion === 'releases'\s*\?\s*<a className="btn primary" href=\{RELEASES_PAGE\}[^\n]*Download from GitHub releases[\s\S]*:\s*<a className="btn primary" href=\{companion\.url\} target="_blank" rel="noreferrer">[^\n]*Download for Windows/, 'a failed download never replaces a page that is uploading')
  assert.deepEqual([...new Set([...card.matchAll(/href=\{?["'`]?([^}"'`\s>]+)/g)].map((m) => m[1]))].sort(), ['RELEASES_PAGE', 'companion.url'])
  assert.ok(setup.indexOf('companion-offer') < setup.indexOf('<h3>1. Choose your Data folder</h3>'), 'the card comes before the browser upload')
  assert.ok(setup.lastIndexOf('{canEdit && <>', setup.indexOf('companion-offer')) !== -1, 'only those who can upload see it')
  const app = readFileSync(`${WEB}/landing/App.tsx`, 'utf8')
  assert.ok(!/companionUrl|latest\/download/.test(app))
  assert.ok(app.indexOf('id="rent"') < app.indexOf('id="nvmp-companion"'), 'the companion follows the rent pitch it serves')
  const section = app.slice(app.indexOf('id="nvmp-companion"'), app.indexOf('id="download"'))
  assert.match(
    section,
    /companion === 'missing' \?[\s\S]*Coming soon[\s\S]*: companion === 'unknown' \?[\s\S]*href=\{RELEASES_PAGE\}[\s\S]*Download from GitHub releases[\s\S]*: companion \?[\s\S]*href=\{companion\.url\}[\s\S]*: null\}/
  )
  // the only links in the section: the verified asset and the releases list
  assert.deepEqual([...new Set([...section.matchAll(/href=\{?["'`]?([^}"'`\s>]+)/g)].map((m) => m[1]))].sort(), ['RELEASES_PAGE', 'companion.url'])
  assert.match(app, /import \{[^}]*\bRELEASES_PAGE\b[^}]*\} from '@web\/lib\/companion'/)
})

test('the releases-list fallback is the list itself, not /latest or an asset', () => {
  assert.equal(lib.RELEASES_PAGE, RELEASES_LIST)
})
