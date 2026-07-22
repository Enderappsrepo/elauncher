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

// project Pages site: https://enderappsrepo.github.io/elauncher/. Override when
// moving to a custom domain, where the site sits at the root instead.
const base = process.env.ELAUNCHER_WEB_BASE ?? '/elauncher/'

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
    outDir: resolve(__dirname, 'docs'),
    // docs/ is not a build artefact directory — it also holds .nojekyll, the
    // hosting guides, the PWA icons, the manifest and sw.js, all hand-maintained.
    // Emptying it would delete every one of them.
    emptyOutDir: false,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'web/index.html'),
        manage: resolve(__dirname, 'web/manage/index.html')
      }
    }
  },
  server: { port: 5174 }
})
