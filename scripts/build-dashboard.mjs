// Publish just /manage/; preserve the landing page, guides, icons and old assets.
import { resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build, loadConfigFromFile } from 'vite'

const root = resolve(import.meta.dirname, '..')
process.env.ELAUNCHER_WEB_STAGE = ''
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' }, resolve(root, 'vite.web.config.ts')
)
if (!loaded) throw new Error('Could not load the hosting dashboard build configuration.')
const result = await build({
  ...loaded.config,
  configFile: false,
  build: {
    ...loaded.config.build,
    outDir: resolve(root, 'docs'),
    emptyOutDir: false,
    rollupOptions: {
      ...loaded.config.build?.rollupOptions,
      input: { manage: resolve(root, 'web/manage/index.html') }
    }
  }
})
// Keep the emitted file list outside Git so a release can include exactly this
// build's assets without deleting bundles still used by the landing page.
const outputs = Array.isArray(result) ? result : [result]
const files = outputs.flatMap((output) => 'output' in output ? output.output.map((file) => `docs/${file.fileName}`) : [])
for (const name of files.filter((name) => name.endsWith('.html'))) {
  const path = resolve(root, name)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\r/g, ''))
}
const cache = resolve(root, 'node_modules/.cache')
mkdirSync(cache, { recursive: true })
writeFileSync(resolve(cache, 'dashboard-build-files.json'), JSON.stringify(files, null, 2))
