import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri drives the dev server on a fixed port and talks to it from the webview.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome110',
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: false,
  },
})
