// Render the actual storefront without a cloud login or changes to paid plans.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { runInThisContext } from 'node:vm'
import { test } from 'node:test'
import { parse } from '@babel/parser'
import { transformSync } from 'esbuild'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

const root = resolve(import.meta.dirname, '..')
const require = createRequire(import.meta.url)
const source = readFileSync(resolve(root, 'web/src/panel/views/Shop.tsx'), 'utf8')
const ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
const names = ['Storefront', 'NvmpPreview', 'GameBadge', 'money', 'specs', 'headline']
const selected = ast.program.body.filter((n) => n.type === 'FunctionDeclaration' && names.includes(n.id?.name)).map((n) => source.slice(n.start, n.end)).join('\n')
assert.equal(names.length, ast.program.body.filter((n) => n.type === 'FunctionDeclaration' && names.includes(n.id?.name)).length)
const js = transformSync(selected + '\nexport { Storefront, headline };', { loader: 'tsx', jsx: 'automatic', format: 'cjs', target: 'es2022' }).code
const module = { exports: {} }
runInThisContext(`(function(require,module,exports,Button,GAME_HUE,GAME_BLURB,gameLabel){${js}\n})`)(
  require, module, module.exports, ({ children, ...props }) => createElement('button', props, children),
  { nvmp: 45, minecraft: 140 }, {}, (game) => game === 'nvmp' ? 'Fallout: New Vegas (NV:MP)' : 'Minecraft'
)
const { Storefront, headline } = module.exports
const mc = { id: 'mc', name: 'Minecraft plan', game: 'minecraft', price_monthly: 5, currency: 'USD', memory_mb: 2048, max_players: 10, cpu_cores: null }
const nvmp = { ...mc, id: 'nvmp', name: 'NVMP co-op', game: 'nvmp' }
const render = (plans, shopOpen = true) => renderToStaticMarkup(createElement(Storefront, { plans, settings: { shopOpen }, owing: 0, onChoose: () => { throw new Error('No orders during render') } }))
test('NVMP is visible beside existing plans even without an NVMP database row', () => {
  const html = render([mc])
  assert.match(html, /Fallout: New Vegas \(NV:MP\)/)
  assert.match(html, /Coming soon/)
  assert.match(html, /Minecraft plan/)
  assert.equal((html.match(/Choose plan/g) || []).length, 1)
})
test('preview has no price or checkout and clearly says ordering is unavailable', () => {
  const html = render([])
  assert.match(html, /disabled=""[^>]*>Not available yet/)
  assert.match(html, /Orders are not open yet/)
  assert.doesNotMatch(html, /Choose plan|shop-price|\$0/)
})
test('an active NVMP plan replaces the preview instead of duplicating it', () => {
  const html = render([mc, nvmp])
  assert.doesNotMatch(html, /Coming soon|Upcoming NV:MP/)
  assert.match(html, /NVMP co-op/)
  assert.equal((html.match(/Choose plan/g) || []).length, 2)
})
test('closed shops retain the upcoming listing without offering existing plans', () => {
  const html = render([mc], false)
  assert.match(html, /shop is closed/)
  assert.match(html, /Coming soon/)
  assert.doesNotMatch(html, /Choose plan/)
})
test('empty shop headline distinguishes unavailable orders from upcoming games', () => {
  assert.equal(headline([], { shopOpen: true }, false, null), 'No plans available to order')
})
