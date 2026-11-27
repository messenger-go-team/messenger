import { defineConfig } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL
const loopback = /^http:\/\/127\.0\.0\.1:([1-9]\d{0,4})\/?$/.exec(baseURL ?? '')
if (!loopback || Number(loopback[1]) > 65535) {
  throw new Error('E2E_BASE_URL must be the published loopback origin of the local Compose gateway')
}

const run = process.env.E2E_RUN ?? 'local'
if (!/^[a-zA-Z0-9_-]+$/.test(run)) {
  throw new Error('E2E_RUN must contain only letters, digits, dashes or underscores')
}

export default defineConfig({
  testDir: '.',
  testMatch: '**/*.spec.ts',
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  outputDir: `test-results/${run}`,
  reporter: [['list'], ['junit', { outputFile: `test-results/${run}.xml` }]],
  use: {
    baseURL,
    browserName: 'chromium',
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
})
