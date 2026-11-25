import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { loadEnv } from 'vite'
import { defineConfig } from 'vitest/config'
import { assertBuildProfile, resolveAppBase } from './src/app/basename.ts'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, __dirname)
  const base = resolveAppBase(mode, env)
  const staticBuild = command === 'build' || mode === 'production' || mode === 'staging'

  return {
    base,
    // public/ содержит MSW worker, который нужен при локальной разработке.
    publicDir: staticBuild ? false : 'public',
    plugins: [
      {
        name: 'validate-build-profile',
        configResolved(config) {
          // Vite applies inline base and environment overrides before this hook.
          if (staticBuild) assertBuildProfile(config.mode, config.base, config.env)
        },
      },
      react(),
      tailwindcss(),
    ],
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
