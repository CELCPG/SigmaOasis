import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

// v4.4 (electron-vite 5): `build.externalizeDeps` replaces the deprecated
// externalizeDepsPlugin() and does the same thing — package.json's
// `dependencies` stay require()s in out/main and out/preload, loaded from the
// app's node_modules. 5 turns it on for main and preload by default; it is
// spelled out so the bundles' shape does not hang on a default. The renderer
// bundles everything, as before.
export default defineConfig({
  main: {
    build: {
      externalizeDeps: true,
      outDir: 'out/main',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // v3.1 (M4): PDF extraction's worker, beside index.js — ipc/pdfOffThread.ts.
          pdfWorker: resolve(__dirname, 'src/main/ipc/pdfWorker.ts')
        }
      }
    }
  },
  preload: {
    build: {
      externalizeDeps: true,
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          workbench: resolve(__dirname, 'src/preload/workbench.ts')
        }
      }
    }
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    build: {
      outDir: 'out/renderer',
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') }
      }
    },
    resolve: {
      alias: { '@': resolve(__dirname, 'src/renderer/src') }
    }
  }
})
