import { build } from 'vite'

if (process.argv.length > 2) {
  throw new Error('Команда build:staging использует фиксированные параметры Vite.')
}

await build({ mode: 'staging' })
