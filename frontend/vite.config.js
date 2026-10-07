import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/events': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/log-events': { target: 'http://127.0.0.1:3000', changeOrigin: true },
      '/health': 'http://127.0.0.1:3000',
    },
  },
  build: {
    outDir: '../dist-frontend',
    emptyOutDir: true,
  },
})
