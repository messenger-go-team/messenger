const { defineConfig } = require("@playwright/test");
const negative = process.env.TRIAL_NEGATIVE === "1";
module.exports = defineConfig({
  testDir: "./playwright",
  timeout: 15000,
  expect: { timeout: 3000 },
  workers: 1,
  retries: 0,
  outputDir: `reports/playwright-${negative ? "negative" : "pass"}-artifacts`,
  reporter: [["list"], ["json", { outputFile: `reports/playwright-${negative ? "negative" : "pass"}.json` }], ["junit", { outputFile: `reports/playwright-${negative ? "negative" : "pass"}.xml` }]],
  use: { baseURL: "http://127.0.0.1:3100", browserName: "chromium", headless: true, trace: "retain-on-failure" },
  webServer: process.env.TRIAL_EXTERNAL_SERVER === "1" ? undefined : {
    command: "node server.cjs", url: "http://127.0.0.1:3100/health", reuseExistingServer: false, timeout: 10000
  }
});
