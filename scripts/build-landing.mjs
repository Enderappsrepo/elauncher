// Publish just the landing page (docs/index.html); preserve the dashboard, guides, icons and old assets.
// The landing-page counterpart of build-dashboard.mjs: the two pages are published separately, so
// neither deploy rewrites the other page's bundles.
import { resolve } from 'node:path'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { build, loadConfigFromFile } from 'vite'

const root = resolve(import.meta.dirname, '..')
process.env.ELAUNCHER_WEB_STAGE = ''
const loaded = await loadConfigFromFile(
  { command: 'build', mode: 'production' }, resolve(root, 'vite.web.config.ts')
)
if (!loaded) throw new Error('Could not load the landing page build configuration.')
const result = await build({
  ...loaded.config,
  configFile: false,
  build: {
    ...loaded.config.build,
    outDir: resolve(root, 'docs'),
    emptyOutDir: false,
    rollupOptions: {
      ...loaded.config.build?.rollupOptions,
      input: { index: resolve(root, 'web/index.html') }
    }
  }
})
// Keep the emitted file list outside Git, as build-dashboard.mjs does, so a release can include
// exactly this build's assets.
const outputs = Array.isArray(result) ? result : [result]
const files = outputs.flatMap((output) => 'output' in output ? output.output.map((file) => `docs/${file.fileName}`) : [])
for (const name of files.filter((name) => name.endsWith('.html'))) {
  const path = resolve(root, name)
  writeFileSync(path, readFileSync(path, 'utf8').replace(/\r/g, ''))
}
const cache = resolve(root, 'node_modules/.cache')
mkdirSync(cache, { recursive: true })
writeFileSync(resolve(cache, 'landing-build-files.json'), JSON.stringify(files, null, 2))
