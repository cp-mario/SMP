import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

// API used by the dev server proxy (start.js / dev.js export SMP_PORT).
const apiOrigin = process.env.SMP_API_ORIGIN || `http://localhost:${process.env.SMP_PORT || 3001}`
const webPort = Number(process.env.SMP_WEB_PORT || 5173)

export default defineConfig({
  plugins: [svelte()],
  build: {
    outDir: new URL('../server/src/public', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'),
    emptyOutDir: true,
    chunkSizeWarningLimit: 2000,
    reportCompressedSize: false,
  },
  worker: { format: 'es' },
  server: {
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': apiOrigin,
    },
  },
})
