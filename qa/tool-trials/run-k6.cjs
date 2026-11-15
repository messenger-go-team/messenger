const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const root = __dirname;
fs.mkdirSync(path.join(root, "reports"), { recursive: true });
const negative = process.argv.includes("--negative");
const binary = process.env.K6_BIN || (process.platform === "win32"
  ? path.join(root, ".tools", "k6-v2.4.0-windows-amd64", "k6.exe") : "k6");
const args = process.argv.includes("--version") ? ["version"] : ["run", "k6/health.js"];
const result = spawnSync(binary, args, {
  cwd: root, stdio: "inherit", env: { ...process.env,
    K6_NO_USAGE_REPORT: "true", K6_NO_COLOR: "true",
    EXPECTED_STATUS: negative ? "201" : "200",
    SUMMARY_FILE: negative ? "reports/k6-negative.json" : "reports/k6-pass.json"
  }
});
if (result.error) { console.error(result.error.message + "; install k6 per README or set K6_BIN"); process.exit(1); }
process.exit(result.status === null ? 1 : result.status);
