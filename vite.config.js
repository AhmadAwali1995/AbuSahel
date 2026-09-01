import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv } from 'vite'
import { voiceApiMiddleware } from './server/voiceApi.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ mode }) => {
  // Third arg '' loads every var, not just VITE_-prefixed ones. These stay on
  // the server — they are never injected into the client bundle.
  const env = loadEnv(mode, process.cwd(), '')
  const voiceApi = voiceApiMiddleware(env)

  return {
    plugins: [
      {
        name: 'abusahel-voice-api',
        configureServer(server) {
          server.middlewares.use(voiceApi)
        },
        configurePreviewServer(server) {
          server.middlewares.use(voiceApi)
        },
      },
    ],
    build: {
      rollupOptions: {
        input: {
          main: resolve(__dirname, 'index.html'),
          voice: resolve(__dirname, 'voice.html'),
        },
      },
    },
    server: {
      proxy: {
        '/v1': {
          target: 'https://faqragsystem-production-88c2.up.railway.app',
          changeOrigin: true,
          secure: true,
        },
      },
    },
  }
})
