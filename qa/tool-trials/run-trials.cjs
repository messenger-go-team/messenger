const { spawn, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = __dirname;
const reports = path.join(root, "reports");
const baseUrl = "http://127.0.0.1:3100";
const net = require("node:net");
fs.mkdirSync(reports, { recursive: true });

function portIsFree() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", () => reject(new Error("Port 3100 is busy; stop the manual trial fixture first.")));
    probe.listen(3100, "127.0.0.1", () => probe.close(() => resolve()));
  });
}
function execute(name, binary, args, expectedExit, extraEnv = {}, cwd = root) {
  const result = spawnSync(binary, args, { cwd, encoding: "utf8", timeout: 120000,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", ...extraEnv } });
  const output = (result.stdout || "") + (result.stderr || "");
  fs.writeFileSync(path.join(reports, name + ".log"), output);
  process.stdout.write(output);
  const actual = result.status;
  const ok = !result.error && actual === expectedExit;
  console.log(`${name}: exit=${actual}, expected=${expectedExit}`);
  return { name, command: [binary, ...args], cwd: path.relative(root, cwd) || ".", environment: extraEnv, expected_exit: expectedExit, actual_exit: actual,
    matched: ok, error: result.error ? result.error.message : null };
}
async function main() {
  await portIsFree();
  const server = spawn(process.execPath, [path.join(root, "server.cjs")], { cwd: root, windowsHide: true, stdio: "ignore" });
  try {
    let ready = false;
    for (let attempt = 0; attempt < 50; attempt++) {
      if (server.exitCode !== null) throw new Error("Trial fixture exited before readiness");
      try {
        const response = await fetch(baseUrl + "/health", { signal: AbortSignal.timeout(500) });
        if (response.status === 200 && (await response.json()).status === "ok") { ready = true; break; }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    if (!ready) throw new Error("Trial fixture readiness timeout");
    const bruno = path.join(root, "node_modules/@usebruno/cli/bin/bru.js");
    const pw = path.join(root, "node_modules/@playwright/test/cli.js");
    const results = [];
    for (const negative of [false, true]) {
      const name = "bruno-" + (negative ? "negative" : "pass");
      results.push(execute(name, process.execPath, [bruno, "run", "--env", negative ? "negative" : "local",
        "--reporter-json", `../reports/${name}.json`, "--reporter-junit", `../reports/${name}.xml`],
        negative ? 1 : 0, {}, path.join(root, "bruno")));
    }
    results.push(execute("playwright-pass", process.execPath, [pw, "test"], 0, { TRIAL_EXTERNAL_SERVER: "1", TRIAL_NEGATIVE: "0" }));
    results.push(execute("playwright-negative", process.execPath, [pw, "test"], 1, { TRIAL_EXTERNAL_SERVER: "1", TRIAL_NEGATIVE: "1" }));
    results.push(execute("k6-pass", process.execPath, ["run-k6.cjs"], 0));
    results.push(execute("k6-negative", process.execPath, ["run-k6.cjs", "--negative"], 99));
    const k6VersionResult = spawnSync(process.execPath, ["run-k6.cjs", "--version"], { cwd: root, encoding: "utf8" });
    if (k6VersionResult.status !== 0) throw new Error("Cannot read k6 version");
    const summary = { date_utc: new Date().toISOString(), fixture: baseUrl,
      versions: { node: process.version, bruno: require("@usebruno/cli/package.json").version,
        playwright: require("@playwright/test/package.json").version, k6: k6VersionResult.stdout.trim() }, results };
    fs.writeFileSync(path.join(reports, "trial-summary.json"), JSON.stringify(summary, null, 2) + "\n");
    if (results.some(result => !result.matched)) process.exitCode = 1;
  } finally {
    if (server.exitCode === null) {
      await new Promise(resolve => { server.once("exit", resolve); server.kill(); });
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
