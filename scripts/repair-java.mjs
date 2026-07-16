import { fetchJavaRuntimeManifest, installJavaRuntimeTask } from '@xmcl/installer'
import { join } from 'path'
import { readdirSync, statSync } from 'fs'

const destination = join(process.env.APPDATA, 'elauncher-data', 'java', 'java-runtime-epsilon')

function countZero(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) n += countZero(p)
    else if (statSync(p).size === 0) n++
  }
  return n
}

console.log('zero-byte files before:', countZero(destination))
const manifest = await fetchJavaRuntimeManifest({ target: 'java-runtime-epsilon' })
const task = installJavaRuntimeTask({ destination, manifest })
await task.startAndWait({})
console.log('zero-byte files after:', countZero(destination))
