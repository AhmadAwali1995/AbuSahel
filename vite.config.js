import { defineConfig } from 'vite'

export default defineConfig({
  server: {
    proxy: {
      '/v1': {
        target: 'https://pitch-administered-visibility-diameter.trycloudflare.com',
        changeOrigin: true,
        secure: true,
      },
    },
  },
})
