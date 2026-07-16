// Reproduce the exact launch the app performs, but with console java to capture errors.
import { Version, generateArguments, LaunchPrecheck, MinecraftFolder } from '@xmcl/core'
import { spawn } from 'child_process'
import { join } from 'path'

const shared = join(process.env.APPDATA, 'elauncher-data', 'shared')
const gameDir = join(process.env.APPDATA, 'elauncher-data', 'instances', 'de5ad640-9e5e-41f2-9d9a-e986c062c0f4')
const javaExe = join(process.env.APPDATA, 'elauncher-data', 'java', 'java-runtime-epsilon', 'bin', 'java.exe')

const resolved = await Version.parse(shared, '26.2')
console.log('version resolved:', resolved.id, 'minecraftVersion:', resolved.minecraftVersion)

const options = {
  gamePath: gameDir,
  resourcePath: shared,
  javaPath: javaExe,
  version: resolved,
  accessToken: 'dummy',
  gameProfile: { name: 'Test', id: '8e7f6f2ef837469b83debbfff78195dc' },
  maxMemory: 4096,
  launcherName: 'ELauncher',
  launcherBrand: 'elauncher'
}

// run the same prechecks launch() would run
const folder = MinecraftFolder.from(shared)
for (const check of LaunchPrecheck.DEFAULT_PRECHECKS) {
  try {
    await check(folder, resolved, options)
    console.log('precheck ok')
  } catch (e) {
    console.error('PRECHECK FAILED:', e)
    process.exit(1)
  }
}

const args = await generateArguments(options)
console.log('java args generated,', args.length, 'entries')
console.log('main class region:', args.slice(-30).join(' '))

const proc = spawn(args[0], args.slice(1), { cwd: gameDir })
proc.stdout.on('data', (d) => process.stdout.write(d))
proc.stderr.on('data', (d) => process.stderr.write(d))
proc.on('exit', (code) => {
  console.log('\nEXIT CODE:', code)
})
// kill after 25s if it started fine
setTimeout(() => {
  console.log('\n[timeout reached, killing test game]')
  proc.kill()
}, 25000)
