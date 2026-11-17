import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // so phones on the same wifi can join during development
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
