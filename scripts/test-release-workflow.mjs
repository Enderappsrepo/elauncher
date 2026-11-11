// The Release workflow builds the companion in its own job, which every publishing job
// waits for, and attaches it only when the package.json tag is the checked-out commit.
//   node --test scripts/test-release-workflow.mjs
//   WORKFLOW=<path> node --test scripts/test-release-workflow.mjs   (checks another copy)
//   GIT_BASH=<path to bash> node --test scripts/test-release-workflow.mjs   (otherwise found by itself)
// The attach step's own `run:` script is executed in scratch git repos under the OS temp folder, with a
// stub `gh` on PATH. Without git or a usable bash those cases are skipped, and the skip says why.
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const yaml = createRequire(join(REPO, 'package.json'))('js-yaml')
const WORKFLOW = process.env.WORKFLOW ?? join(REPO, '.github/workflows/release.yml')

const COMPANION_EXE = 'release-companion/ELauncher-NVMP-Companion.exe'
const workflow = yaml.load(readFileSync(WORKFLOW, 'utf8'))
const jobs = workflow.jobs
const needsOf = (job) => [jobs[job]?.needs ?? []].flat()
const runs = (job) => (jobs[job]?.steps ?? []).map((s) => s.run ?? '').join('\n')
/** A step that publishes to GitHub releases: electron-builder publishing, or the gh CLI writing a release. */
const publishes = (s) => /--publish[=\s]+(?!never\b)\S+/.test(s.run ?? '') || /\bgh\s+release\s+(?!view\b|list\b|download\b)\w+/.test(s.run ?? '')
/** A condition that would run a step or job even after what it depends on failed. */
const runsAnyway = (cond) => /\b(always|failure|cancelled)\s*\(/.test(String(cond ?? ''))

const steps = jobs.release.steps
const index = (pred, what) => {
  const i = steps.findIndex(pred)
  assert.notEqual(i, -1, `no step in the release job: ${what}`)
  return i
}
const isAttach = (s) => /gh release upload/.test(s.run ?? '')

test('the companion is built in a job of its own, which never publishes', () => {
  const job = jobs.companion
  assert.ok(job, 'no companion job: the companion must be built before, and apart from, the matrix that publishes')
  assert.equal(job['runs-on'], 'windows-latest')
  const s = job.steps
  const install = s.findIndex((x) => /\bnpm ci\b/.test(x.run ?? ''))
  const bundle = s.findIndex((x) => /\bnpm run companion:(build|dist)\b/.test(x.run ?? ''))
  const pack = s.findIndex((x) => /electron-builder\b.*--config electron-builder\.companion\.yml/.test(x.run ?? '') || /companion:dist/.test(x.run ?? ''))
  const upload = s.findIndex((x) => /^actions\/upload-artifact@/.test(x.uses ?? ''))
  assert.ok(install !== -1 && bundle > install, 'npm ci, then npm run companion:build')
  assert.ok(pack >= bundle, 'electron-builder --config electron-builder.companion.yml after the bundle')
  assert.ok(upload > pack, 'actions/upload-artifact after the exe is built')

  // every electron-builder run in the job says --publish never (companion:dist does, in package.json)
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'))
  for (const line of runs('companion').split('\n')) {
    if (/electron-builder\b/.test(line)) assert.match(line, /--publish[=\s]+never\b/, line)
    if (/companion:dist/.test(line)) assert.match(pkg.scripts['companion:dist'], /--publish never\b/)
  }
  assert.deepEqual(s.filter(publishes).map((x) => x.name ?? x.run), [], 'a companion job step publishes')
  // and it could not if it tried: no write token, no GH_TOKEN
  const perms = job.permissions
  assert.ok(
    perms === 'read-all' || (perms && typeof perms === 'object' && !Object.values(perms).includes('write')),
    `companion job permissions must be read-only, got ${JSON.stringify(perms)}`
  )
  assert.doesNotMatch(JSON.stringify(job), /secrets\.|GH_TOKEN|GITHUB_TOKEN/)

  const up = s[upload].with ?? {}
  assert.equal(up.path, COMPANION_EXE)
  assert.equal(up['if-no-files-found'], 'error', 'upload-artifact only warns by default: a missing exe must fail the job')
  assert.ok(up.name, 'the artifact needs a name to download it by')
})

test('nothing publishes unless the companion job succeeded', () => {
  for (const [name, job] of Object.entries(jobs)) {
    if (name === 'companion' || !(job.steps ?? []).some(publishes)) continue
    assert.ok(needsOf(name).includes('companion'), `job ${name} publishes without needs: companion`)
    assert.ok(!runsAnyway(job.if), `job ${name} runs even when the companion failed: if: ${job.if}`)
  }
  assert.deepEqual(needsOf('release'), ['companion'])
  // a companion failure must fail its job: no continue-on-error, no step that runs regardless
  assert.ok(!jobs.companion['continue-on-error'], 'the companion job must not continue on error')
  for (const step of jobs.companion.steps ?? []) {
    assert.ok(!step['continue-on-error'] && !runsAnyway(step.if), `companion step ${step.name ?? step.uses} must not swallow a failure`)
  }
  // the release matrix no longer builds the companion itself, so no leg can publish ahead of that build
  assert.doesNotMatch(runs('release'), /companion:(build|dist)|electron-builder\.companion\.yml/)
  // the launcher's own publish order is unchanged: one platform at a time
  assert.equal(jobs.release.strategy['max-parallel'], 1)
})

test("the Windows leg attaches the companion job's exe after the launcher publish", () => {
  const publish = index((s) => s.name === 'Package and publish', 'Package and publish')
  const download = index((s) => /^actions\/download-artifact@/.test(s.uses ?? ''), 'actions/download-artifact')
  const attach = index(isAttach, 'companion upload')
  assert.ok(publish < download && download < attach, `order: publish ${publish}, download ${download}, attach ${attach}`)
  for (const i of [download, attach]) {
    assert.equal(String(steps[i].if ?? '').trim(), "matrix.os == 'windows-latest'", steps[i].name)
    assert.ok(!runsAnyway(steps[i].if) && !steps[i]['continue-on-error'], `${steps[i].name} must run only after a successful publish`)
  }
  // the attach script is bash, and gh needs the job's write token
  assert.equal(steps[attach].shell, 'bash')
  assert.match(String(steps[attach].env?.GH_TOKEN ?? ''), /secrets\.GITHUB_TOKEN/)
  assert.equal((jobs.release.permissions ?? workflow.permissions)?.contents, 'write')
  const up = jobs.companion?.steps.find((x) => /^actions\/upload-artifact@/.test(x.uses ?? ''))?.with
  assert.ok(up, 'no companion job artifact to download')
  assert.equal(steps[download].with?.name, up.name, 'downloads the artifact the companion job uploaded')
  assert.equal(`${steps[download].with?.path}/${basename(up.path)}`, COMPANION_EXE)
  assert.ok(steps[attach].run.includes(`gh release upload "$tag" ${COMPANION_EXE} `), steps[attach].run)
})

// ---- execute the attach script against scratch repos -------------------------------------

/** Git Bash style path: C:\x\y -> /c/x/y (unchanged on macOS and Linux). */
const posix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => `/${d.toLowerCase()}`)
const ok = (cmd, args) => {
  try {
    return spawnSync(cmd, args, { encoding: 'utf8', timeout: 20_000 }).status === 0
  } catch {
    return false
  }
}

/** A bash that can run the attach script here: sees our paths, git and node. null when there is none. */
function findBash() {
  if (process.env.GIT_BASH) return process.env.GIT_BASH
  const candidates = []
  if (process.platform === 'win32') {
    // Git for Windows: `git --exec-path` is <git>/<mingw64|clangarm64|...>/libexec/git-core
    const exec = spawnSync('git', ['--exec-path'], { encoding: 'utf8' })
    if (exec.status === 0 && exec.stdout.trim()) {
      const root = resolve(exec.stdout.trim(), '..', '..', '..')
      candidates.push(join(root, 'bin', 'bash.exe'), join(root, 'usr', 'bin', 'bash.exe'))
    }
    // any other bash on PATH, except System32's WSL launcher, which does not see C:\ as /c
    const where = spawnSync('where', ['bash'], { encoding: 'utf8' })
    const system = (process.env.SystemRoot ?? 'C:\\Windows').toLowerCase() + sep
    for (const p of (where.status === 0 ? where.stdout : '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean))
      if (!p.toLowerCase().startsWith(system) && !/\\WindowsApps\\/i.test(p)) candidates.push(p)
  } else {
    candidates.push('bash')
  }
  const probe = `test -d "${posix(tmpdir())}" && command -v git >/dev/null && command -v node >/dev/null`
  return candidates.find((c) => (c === 'bash' || existsSync(c)) && ok(c, ['--noprofile', '--norc', '-c', probe])) ?? null
}

const HAS_GIT = ok('git', ['--version'])
const BASH = HAS_GIT ? findBash() : null
const SKIP = !HAS_GIT
  ? 'git is not on PATH, so the attach script cannot be run against scratch repos'
  : !BASH
    ? "no usable bash found (bash on PATH on macOS/Linux, or Git for Windows' bash.exe beside `git --exec-path`); set GIT_BASH to one to run these cases"
    : false

const git = (cwd, ...args) => {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`)
  return r.stdout.trim()
}

describe('the attach script uploads only when the package.json tag is the checked-out commit', { skip: SKIP }, () => {
  let root
  let url
  let stub

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'elauncher-release-wf-'))
    const origin = join(root, 'origin.git')
    url = `file:///${origin.replace(/\\/g, '/').replace(/^\//, '')}`
    stub = join(root, 'stub')
    mkdirSync(stub)
    // like the real gh, refuses without a token: the step itself must provide GH_TOKEN
    writeFileSync(join(stub, 'gh'), '#!/usr/bin/env bash\n[ -n "$GH_TOKEN" ] || { echo "gh: no GH_TOKEN" >&2; exit 4; }\necho "$@" >> "$GH_LOG"\n', { mode: 0o755 })

    const seed = join(root, 'seed')
    mkdirSync(seed)
    git(root, 'init', '-q', '--bare', origin)
    git(seed, 'init', '-q', '-b', 'main')
    git(seed, 'config', 'user.email', 't@example.invalid')
    git(seed, 'config', 'user.name', 't')
    git(seed, 'config', 'commit.gpgsign', 'false')
    git(seed, 'config', 'tag.gpgsign', 'false')
    writeFileSync(join(seed, 'package.json'), '{ "version": "1.2.3" }\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'A: 1.2.3')
    git(seed, 'tag', '-a', 'v1.2.3', '-m', 'v1.2.3') // npm version makes annotated tags
    git(seed, 'branch', 'at-tag')
    writeFileSync(join(seed, 'README'), 'more work, no version bump\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-q', '-m', 'B: past the tag')
    git(seed, 'checkout', '-q', '-b', 'bump')
    writeFileSync(join(seed, 'package.json'), '{ "version": "1.2.4" }\n')
    git(seed, 'commit', '-q', '-am', 'C: 1.2.4, never tagged')
    git(seed, 'push', '-q', url, 'main', 'at-tag', 'bump', 'v1.2.3')
  })

  after(() => {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 3 })
  })

  /** A checkout the way actions/checkout@v4 makes one: depth 1, no tags. */
  function checkout(name, refspec, rev) {
    const dir = join(root, name)
    mkdirSync(dir)
    git(dir, 'init', '-q')
    git(dir, 'remote', 'add', 'origin', url)
    git(dir, 'fetch', '-q', '--no-tags', '--depth=1', 'origin', refspec)
    git(dir, 'checkout', '-q', '--detach', rev)
    return dir
  }

  function runAttach(dir) {
    const log = join(dir, 'gh.log')
    const script = join(dir, 'attach.sh')
    const step = steps[index(isAttach, 'companion upload')]
    writeFileSync(script, `PATH="${posix(stub)}:$PATH"\n${step.run}`)
    const env = { ...process.env, GH_LOG: log, GITHUB_REPOSITORY: 'owner/repo' }
    delete env.GH_TOKEN
    if (step.env?.GH_TOKEN) env.GH_TOKEN = 'dummy' // what ${{ secrets.GITHUB_TOKEN }} becomes in a run
    const r = spawnSync(BASH, ['--noprofile', '--norc', '-eo', 'pipefail', script], { cwd: dir, encoding: 'utf8', env })
    return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}${r.error ?? ''}`, gh: existsSync(log) ? readFileSync(log, 'utf8').trim() : null }
  }

  test('a tag push uploads to that tag', () => {
    const r = runAttach(checkout('tag-push', '+refs/tags/v1.2.3:refs/tags/v1.2.3', 'v1.2.3'))
    assert.equal(r.status, 0, r.out)
    assert.equal(r.gh, `release upload v1.2.3 ${COMPANION_EXE} --clobber --repo owner/repo`)
  })

  test('a tag push checked out the way actions/checkout does it (lightweight tag at the sha) uploads', () => {
    const sha = git(join(root, 'seed'), 'rev-parse', 'at-tag')
    const r = runAttach(checkout('tag-push-lightweight', `+${sha}:refs/tags/v1.2.3`, 'v1.2.3'))
    assert.equal(r.status, 0, r.out)
    assert.match(r.gh ?? '', /^release upload v1\.2\.3 /)
  })

  test('a manual run from a branch whose HEAD is the tagged commit still uploads', () => {
    const r = runAttach(checkout('dispatch-at-tag', '+refs/heads/at-tag:refs/remotes/origin/at-tag', 'origin/at-tag'))
    assert.equal(r.status, 0, r.out)
    assert.match(r.gh ?? '', /^release upload v1\.2\.3 /)
  })

  test('a manual run from a branch past the tag does not replace the published companion', () => {
    const r = runAttach(checkout('dispatch-past-tag', '+refs/heads/main:refs/remotes/origin/main', 'origin/main'))
    assert.equal(r.status, 0, r.out)
    assert.equal(r.gh, null, `gh was called: ${r.gh}`)
    assert.match(r.out, /::warning::v1\.2\.3 does not point at the checked-out commit/)
  })

  test('a version with no tag on origin skips the upload with a warning', () => {
    const r = runAttach(checkout('dispatch-untagged', '+refs/heads/bump:refs/remotes/origin/bump', 'origin/bump'))
    assert.equal(r.status, 0, r.out)
    assert.equal(r.gh, null, `gh was called: ${r.gh}`)
    assert.match(r.out, /::warning::Tag v1\.2\.4 was not found on origin/)
  })

  test('an origin that cannot be reached fails the step instead of skipping the upload', () => {
    const dir = checkout('unreachable', '+refs/tags/v1.2.3:refs/tags/v1.2.3', 'v1.2.3')
    git(dir, 'remote', 'set-url', 'origin', `${url}-missing`)
    const r = runAttach(dir)
    assert.notEqual(r.status, 0, r.out)
    assert.equal(r.gh, null, `gh was called: ${r.gh}`)
    assert.match(r.out, /::error::Could not check origin for tag v1\.2\.3/)
  })
})
