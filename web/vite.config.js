import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vite'

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
    port: 5173,
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})