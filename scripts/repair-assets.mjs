import { installDependenciesTask } from '@xmcl/installer'
import { Version } from '@xmcl/core'
import { Agent } from 'undici'
import { join } from 'path'
import { readdirSync, statSync } from 'fs'

const dispatcher = new Agent({ connect: { autoSelectFamily: true, timeout: 15000 }, connections: 16, bodyTimeout: 120000 })

const shared = join(process.env.APPDATA, 'elauncher-data', 'shared')

function countZero(dir) {
  let n = 0
  let total = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      const [z, t] = countZero(p)
      n += z
      total += t
    } else {
      total++
      if (statSync(p).size === 0) n++
    }
  }
  return [n, total]
}

const objects = join(shared, 'assets', 'objects')
console.log('assets zero/total before:', countZero(objects).join('/'))

const resolved = await Version.parse(shared, '26.2')
for (let attempt = 1; attempt <= 4; attempt++) {
  const task = installDependenciesTask(resolved, { dispatcher })
  let last = 0
  try {
    await task.startAndWait({
      onUpdate() {
        if (Date.now() - last > 3000) {
          last = Date.now()
          console.log('progress:', task.progress, '/', task.total)
        }
      }
    })
    break
  } catch (e) {
    const n = e instanceof AggregateError ? e.errors.length : 1
    console.log(`attempt ${attempt} failed with ${n} error(s), retrying...`)
  }
}
console.log('assets zero/total after:', countZero(objects).join('/'))
