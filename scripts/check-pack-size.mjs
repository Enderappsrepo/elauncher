// One-off diagnostic: estimate the published .mrpack size for an instance by
// running the same Modrinth sha1 lookup that buildMrpack uses.
import { createHash } from 'crypto'
import { readFileSync, readdirSync, existsSync, statSync } from 'fs'
import { join } from 'path'

const instanceDir = process.argv[2]
if (!instanceDir) {
  console.error('usage: node check-pack-size.mjs <instance dir>')
  process.exit(1)
}

const meta = JSON.parse(readFileSync(join(instanceDir, 'elauncher-mods.json'), 'utf-8'))
const modsDir = join(instanceDir, 'mods')

const unknown = []
for (const file of readdirSync(modsDir)) {
  if (!file.endsWith('.jar')) continue
  const record = meta[file]
  if (record && record.source === 'modrinth' && record.sha1 && record.sha512) continue
  if (record && record.source === 'curseforge' && record.downloadUrl) continue
  const buf = readFileSync(join(modsDir, file))
  unknown.push({ file, sha1: createHash('sha1').update(buf).digest('hex'), size: buf.length })
}

const res = await fetch('https://api.modrinth.com/v2/version_files', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'User-Agent': 'ELauncher/0.1.0 (custom launcher)' },
  body: JSON.stringify({ hashes: unknown.map((u) => u.sha1), algorithm: 'sha1' })
})
const found = res.ok ? await res.json() : {}

let embedded = 0
console.log('Jars that will be EMBEDDED in the pack (not found on Modrinth):')
for (const u of unknown) {
  if (found[u.sha1]) continue
  embedded += u.size
  console.log(`  ${(u.size / 1048576).toFixed(1).padStart(7)} MB  ${u.file}`)
}

let overrides = 0
const walk = (dir) => {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p)
    else overrides += statSync(p).size
  }
}
for (const extra of ['options.txt', 'servers.dat']) {
  const p = join(instanceDir, extra)
  if (existsSync(p)) overrides += statSync(p).size
}
for (const folder of ['config', 'resourcepacks']) {
  const p = join(instanceDir, folder)
  if (existsSync(p)) walk(p)
}

console.log(`\nMatched on Modrinth by hash: ${unknown.filter((u) => found[u.sha1]).length}/${unknown.length}`)
console.log(`Embedded jars:   ${(embedded / 1048576).toFixed(1)} MB`)
console.log(`Other overrides: ${(overrides / 1048576).toFixed(1)} MB (config, resourcepacks, options, servers)`)
console.log(`Approx pack size (before zip compression): ${((embedded + overrides) / 1048576).toFixed(1)} MB`)
