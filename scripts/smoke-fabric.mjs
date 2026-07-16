// Verify fabric install + dependency download + launch argument generation for MC 26.2
import { installFabric, installDependenciesTask } from '@xmcl/installer'
import { Version, generateArguments, LaunchPrecheck, MinecraftFolder } from '@xmcl/core'
import { Agent } from 'undici'
import { join } from 'path'
import { mkdirSync } from 'fs'

const shared = join(process.env.APPDATA, 'elauncher-data', 'shared')
const dispatcher = new Agent({ connect: { autoSelectFamily: true, timeout: 15000 }, connections: 16, bodyTimeout: 120000 })

const loaders = await (await fetch('https://meta.fabricmc.net/v2/versions/loader/26.2')).json()
const loaderVersion = loaders[0].loader.version
console.log('installing fabric', loaderVersion, 'for MC 26.2')

const id = await installFabric({ minecraftVersion: '26.2', version: loaderVersion, minecraft: shared })
console.log('fabric version id:', id)

const resolved = await Version.parse(shared, id)
console.log('inheritsFrom chain ok, libraries:', resolved.libraries.length, 'mainClass:', resolved.mainClass)

for (let attempt = 1; attempt <= 3; attempt++) {
  try {
    const task = installDependenciesTask(resolved, { dispatcher })
    await task.startAndWait()
    break
  } catch (e) {
    console.log('deps attempt', attempt, 'failed:', e instanceof AggregateError ? `${e.errors.length} errors` : e.message)
    if (attempt === 3) throw e
  }
}
console.log('dependencies installed')

const gameDir = join(process.env.TEMP, 'elauncher-fabric-test')
mkdirSync(gameDir, { recursive: true })
const options = {
  gamePath: gameDir,
  resourcePath: shared,
  javaPath: join(process.env.APPDATA, 'elauncher-data', 'java', 'java-runtime-epsilon', 'bin', 'javaw.exe'),
  version: resolved,
  accessToken: 'dummy',
  gameProfile: { name: 'Test', id: '00000000000000000000000000000000' },
  maxMemory: 4096
}
const folder = MinecraftFolder.from(shared)
for (const check of LaunchPrecheck.DEFAULT_PRECHECKS) {
  await check(folder, resolved, options)
}
console.log('prechecks passed')
const args = await generateArguments(options)
console.log('main class in args:', args.includes('net.fabricmc.loader.impl.launch.knot.KnotClient'))
console.log('FABRIC SMOKE OK')
