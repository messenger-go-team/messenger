const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawn } = require("node:child_process");
async function main() {
  let canaryRequests = 0;
  const canary = http.createServer((_req, res) => { canaryRequests++; res.end("unexpected target"); });
  await new Promise(resolve => canary.listen(0, "127.0.0.1", resolve));
  const inheritedBaseUrl = `http://127.0.0.1:${canary.address().port}`;
  try {
    const child = spawn(process.execPath, ["run-trials.cjs"], { cwd: __dirname,
      windowsHide: true, env: { ...process.env, BASE_URL: inheritedBaseUrl } });
    let output = "";
    child.stdout.on("data", data => { output += data; });
    child.stderr.on("data", data => { output += data; });
    const status = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
    fs.writeFileSync(path.join(__dirname, "reports", "verification.log"), output);
    assert.equal(status, 0, "trial:all failed; see reports/verification.log");
    assert.equal(canaryRequests, 0, "inherited BASE_URL received traffic");
    const summary = JSON.parse(fs.readFileSync(path.join(__dirname, "reports", "trial-summary.json")));
    assert.equal(summary.results.length, 7);
    assert.ok(summary.results.every(result => result.matched && result.report_error === null));
    for (const result of summary.results.filter(result => result.name.startsWith("k6"))) {
      assert.equal(result.environment.BASE_URL, "http://127.0.0.1:3100");
    }
    fs.writeFileSync(path.join(__dirname, "reports", "base-url-regression.json"), JSON.stringify({
      date_utc: new Date().toISOString(), inherited_base_url: inheritedBaseUrl,
      canary_requests: canaryRequests, runner_exit: status, reports_verified: 7
    }, null, 2));
    console.log("PASS: seven reports verified; inherited BASE_URL received zero requests.");
  } finally { await new Promise(resolve => canary.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
