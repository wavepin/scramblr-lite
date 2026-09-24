// frontend/vite.config.js
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001', // Use the IP to be safe
        changeOrigin: true,
        // REMOVE the rewrite line entirely
      },
    },
  },
})