import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

/**
 * The ELauncher NVMP Companion: a separate portable app built into out-companion/.
 *
 * The packaged app ships no node_modules, so main and preload bundle their
 * dependencies (supabase-js included) instead of externalizing them.
 *
 * Output folders are fixed here rather than passed as --outDir: electron-vite 5
 * resolves a CLI outDir against the renderer's root, which would nest the
 * renderer build inside companion/renderer.
 */

const out = (part: string): string => resolve(__dirname, 'out-companion', part)

const alias = {
  '@shared': resolve(__dirname, 'src/shared'),
  '@web': resolve(__dirname, 'web/src'),
  '@companion': resolve(__dirname, 'companion')
}

// electron-vite 5's version table stops at Electron 39 (Node 22.20); Electron 43 runs a newer Node.
const NODE_TARGET = 'node22'

export default defineConfig({
  main: {
    build: {
      externalizeDeps: false,
      target: NODE_TARGET,
      outDir: out('main'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'companion/main/index.ts') }
      }
    },
    resolve: { alias }
  },
  preload: {
    build: {
      externalizeDeps: false,
      target: NODE_TARGET,
      outDir: out('preload'),
      rollupOptions: {
        input: { index: resolve(__dirname, 'companion/preload/index.ts') }
      }
    },
    resolve: { alias }
  },
  renderer: {
    root: resolve(__dirname, 'companion/renderer'),
    plugins: [react()],
    build: {
      outDir: out('renderer'),
      // electron-vite leaves the renderer unminified by default; nothing debugs the shipped bundle
      minify: true,
      rollupOptions: {
        input: resolve(__dirname, 'companion/renderer/index.html')
      }
    },
    resolve: { alias }
  }
})
