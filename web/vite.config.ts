import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveAppBase(mode: string, env: Record<string, string>): string {
  const explicit = env.VITE_APP_BASE?.trim()
  if (explicit) {
    return explicit.endsWith('/') ? explicit : `${explicit}/`
  }
  // MSW service worker cannot intercept /auth|/chats|/later from under /app/.
  if (mode === 'test' || env.VITE_API_MOCK === 'true') {
    return '/'
  }
  // Staging/production SPA lives under /app/; REST and WSS stay on domain root.
  return '/app/'
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, __dirname, '')
  const base = resolveAppBase(mode, env)

  return {
    base,
    // public/ сейчас только mockServiceWorker.js — на staging его не раздаём.
    publicDir: mode === 'production' ? false : 'public',
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      globals: true,
    },
  }
})
