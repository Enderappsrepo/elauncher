import { resolve } from 'path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

/**
 * Build for the GitHub Pages site under docs/ — the marketing page and the
 * remote-management panel, as one React app each.
 *
 * Separate from electron.vite.config.ts on purpose: that one builds the desktop
 * app (main + preload + renderer), this one builds the two web pages. They share
 * src/shared, so cloud credentials and design tokens have a single home.
 *
 * The pages used to be zero-build single files, which is why they loaded
 * supabase-js from a CDN and had tokens.css spliced in by scripts/sync-tokens.mjs.
 * With a bundler both go away: real imports, one atomic bundle, and the PWA no
 * longer depends on a third-party CDN being reachable.
 *
 *   npm run web:dev     preview at http://localhost:5174/elauncher/
 *   npm run web:build   emit into docs/
 */

/*
 * Until the rewrite is finished the build lands in docs/next/, published beside
 * the live site at /elauncher/next/ rather than on top of it. Two reasons: the
 * working panel that customers use every day is never one stray `npm run
 * web:build` away from being replaced by a half-ported one, and the new site is
 * reachable on a phone at a real URL instead of only on a dev machine.
 *
 * Cutover is this constant: set ELAUNCHER_WEB_STAGE= (empty) and the same build
 * writes docs/index.html and docs/manage/index.html instead.
 */
const stage = process.env.ELAUNCHER_WEB_STAGE ?? 'next/'

// project Pages site: https://enderappsrepo.github.io/elauncher/. Override when
// moving to a custom domain, where the site sits at the root instead.
const base = process.env.ELAUNCHER_WEB_BASE ?? `/elauncher/${stage}`

export default defineConfig({
  root: 'web',
  base,
  plugins: [react()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@web': resolve(__dirname, 'web/src')
    }
  },
  build: {
    outDir: resolve(__dirname, `docs/${stage}`),
    // docs/next/ holds nothing but build output, so it is emptied each run —
    // otherwise every rebuild leaves the previous content-hashed bundles behind
    // and they accumulate in git forever.
    //
    // At cutover the target becomes docs/ itself, which is NOT a build artefact
    // directory: it also holds .nojekyll, the hosting guides, the PWA icons, the
    // manifest and sw.js, all hand-maintained. Emptying that would delete them.
    emptyOutDir: stage !== '',
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'web/index.html'),
        manage: resolve(__dirname, 'web/manage/index.html')
      }
    }
  },
  server: { port: 5174 }
})
