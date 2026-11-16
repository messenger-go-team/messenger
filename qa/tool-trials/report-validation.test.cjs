const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { bruno, playwright, k6, validateReport } = require("./validate-reports.cjs");
const { assertVersion } = require("./run-k6.cjs");
const reports = path.join(__dirname, "reports");
const read = name => JSON.parse(fs.readFileSync(path.join(reports, name + ".json")));
test("actual negative reports contain precisely the intended failures", () => {
  bruno(read("bruno-negative"), true);
  playwright(read("playwright-negative"), true);
  k6(read("k6-negative"), true);
});
test("Bruno launch errors, missing checks and unrelated failures are rejected", () => {
  for (const mutate of [
    d => { d[0].results[0].error = "module not found"; },
    d => { d[0].results[0].testResults = []; },
    d => { d[0].results[0].testResults[0].error = "schema compilation failed"; },
    d => { d[0].results[0].testResults[1].status = "fail"; }
  ]) {
    const data = read("bruno-negative"); mutate(data);
    assert.throws(() => bruno(data, true));
  }
});
test("Playwright load errors, unrelated assertions and skipped tests are rejected", () => {
  const findSpec = data => data.suites[0].specs[0];
  for (const mutate of [
    d => { d.errors.push({ message: "Cannot find module" }); },
    d => { findSpec(d).tests[0].results[0].errors[0].message = "page.goto timed out"; },
    d => { d.stats.skipped = 1; },
    d => { d.suites[0].specs.pop(); }
  ]) {
    const data = read("playwright-negative"); mutate(data);
    assert.throws(() => playwright(data, true));
  }
});
test("k6 wrong destination and transport failure are rejected", () => {
  for (const mutate of [d => { d.trial.base_url = "https://staging.invalid"; },
    d => { d.metrics.http_req_failed.values.rate = 1; }]) {
    const data = read("k6-negative"); mutate(data); assert.throws(() => k6(data, true));
  }
});
test("missing report is rejected instead of relying on exit code", () => {
  assert.throws(() => validateReport("missing-report", reports));
});
test("k6 version must match on all platforms, including PATH/K6_BIN", () => {
  assertVersion("k6 v2.4.0 (linux/amd64)"); assertVersion("k6.exe v2.4.0 (windows/amd64)");
  for (const version of ["k6 v2.3.0", "k6 v2.4.01", "k6 v2.4.0-rc1", "garbage"]) {
    assert.throws(() => assertVersion(version));
  }
});

test("PoC must propagate bearer and rotated cookie from actual responses", () => {
  bruno(read("bruno-poc"), false, true);
  for (const mutate of [
    d => { d[0].results[1].request.headers.Authorization = "Bearer hardcoded"; },
    d => { d[0].results[4].request.headers.Cookie = "refresh_token=wrong"; },
    d => { d[0].results[6].request.headers.Cookie = "refresh_token=stale"; }
  ]) {
    const data = read("bruno-poc"); mutate(data); assert.throws(() => bruno(data, false, true));
  }
});
