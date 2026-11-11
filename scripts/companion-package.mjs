// Writes out-companion/package.json: the app manifest electron-builder packages for the NVMP
// Companion. No dependencies, because everything is bundled into out-companion by electron-vite.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const out = join(repo, 'out-companion')

const manifest = {
  name: 'elauncher-nvmp-companion',
  productName: 'ELauncher NVMP Companion',
  version: root.version,
  description: 'Finds your Fallout: New Vegas install and uploads its Data folder to your NV:MP server',
  author: root.author,
  license: root.license,
  private: true,
  main: 'main/index.js'
}

mkdirSync(out, { recursive: true })
writeFileSync(join(out, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
console.log(`out-companion/package.json: ${manifest.name} ${manifest.version}`)
