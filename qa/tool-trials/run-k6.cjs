const path = require("node:path");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const expectedVersion = "2.4.0";
function assertVersion(version) {
  if (!/^k6(?:\.exe)? v2\.4\.0(?:\s|$)/.test(version.trim())) {
    throw new Error(`Expected k6 ${expectedVersion}, got: ${version.trim()}`);
  }
}
function main() {
  const root = __dirname;
  fs.mkdirSync(path.join(root, "reports"), { recursive: true });
  const negative = process.argv.includes("--negative");
  const binary = process.env.K6_BIN || (process.platform === "win32"
    ? path.join(root, ".tools", "k6-v2.4.0-windows-amd64", "k6.exe") : "k6");
  const version = spawnSync(binary, ["version"], { encoding: "utf8", windowsHide: true });
  if (version.error) throw version.error;
  if (version.status !== 0) throw new Error("Cannot read k6 version");
  assertVersion(version.stdout);
  if (process.argv.includes("--version")) { process.stdout.write(version.stdout); return; }
  const result = spawnSync(binary, ["run", "k6/health.js"], {
    cwd: root, stdio: "inherit", windowsHide: true, env: { ...process.env,
      BASE_URL: "http://127.0.0.1:3100", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost",
      K6_NO_USAGE_REPORT: "true", K6_NO_COLOR: "true",
      EXPECTED_STATUS: negative ? "201" : "200",
      SUMMARY_FILE: negative ? "reports/k6-negative.json" : "reports/k6-pass.json"
    }
  });
  if (result.error) throw result.error;
  process.exitCode = result.status === null ? 1 : result.status;
}
if (require.main === module) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { assertVersion };
