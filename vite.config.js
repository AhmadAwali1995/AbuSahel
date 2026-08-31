import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/v1': {
        target: 'https://faqragsystem-production-88c2.up.railway.app',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
