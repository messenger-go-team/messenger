const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { XMLParser } = require("fast-xml-parser");
const healthTests = ["HTTP status matches environment", "Response status is ok"];
const pocTests = {
  "01-login.bru": ["login status", "AccessTokenResponse schema", "refresh cookie attributes"],
  "02-me.bru": ["authorized me status", "User schema", "uuid format rejects malformed id", "date-time format rejects malformed timestamp"],
  "03-invalid-me.bru": ["invalid response status", "invalid User schema rejected"],
  "04-contacts.bru": ["authorized contacts status", "nested ref schema"],
  "05-refresh.bru": ["refresh status", "rotated AccessTokenResponse schema", "access token rotated", "refresh cookie rotated"],
  "06-logout.bru": ["logout status", "logout empty body", "cookie cleared"],
  "07-refresh-after-logout.bru": ["refresh after logout status", "ApiError schema"]
};
function bruno(data, negative, poc = false) {
  assert.equal(data.length, 1, "one Bruno iteration required");
  const results = data[0].results;
  const expected = poc ? pocTests : { "health.bru": healthTests };
  assert.equal(results.length, Object.keys(expected).length, "all requests must run");
  assert.deepEqual(results.map(r => path.basename(r.test.filename)).sort(), Object.keys(expected).sort());
  for (const result of results) {
    assert.equal(result.error, null, "request/script launch error must fail");
    assert.ok(result.response, "response missing");
    assert.deepEqual((result.assertionResults || []).filter(r => r.status !== "pass"), []);
    assert.deepEqual(result.preRequestTestResults || [], []);
    assert.deepEqual(result.postResponseTestResults || [], []);
    const names = expected[path.basename(result.test.filename)];
    assert.deepEqual(result.testResults.map(t => t.description), names, "all named checks must run");
    for (const test of result.testResults) {
      const intentional = negative && test.description === healthTests[0];
      assert.equal(test.status, intentional ? "fail" : "pass", test.description);
      if (intentional) assert.equal(test.error, "expected 200 to equal 201");
      else assert.ok(!test.error, test.description);
    }
  }
  if (poc) {
    const headers = request => Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    // Bruno masks outgoing credentials in reports. The fixture accepts only the
    // actual bearer/cookie issued earlier; successful statuses prove propagation.
    for (const result of results.slice(1, 4)) {
      assert.equal(headers(result.request).authorization, "Bearer ********", "masked bearer must be present");
      assert.equal(result.response.status, 200);
    }
    assert.equal(headers(results[4].request).cookie, "********", "refresh must send cookie jar value");
    assert.equal(results[4].response.status, 200);
    assert.equal(headers(results[5].request).cookie, "********", "logout must use rotated cookie");
    assert.equal(results[5].response.status, 204);
    assert.ok(!headers(results[6].request).cookie, "cookie jar must clear cookie after logout");
    assert.equal(results[6].response.status, 401);
  }
  const total = Object.values(expected).flat().length;
  assert.equal(data[0].summary.totalTests, total);
  assert.equal(data[0].summary.failedTests, negative ? 1 : 0);
  assert.equal(data[0].summary.passedTests, total - (negative ? 1 : 0));
  assert.equal(data[0].summary.errorRequests, 0);
}
function playwright(data, negative) {
  assert.deepEqual(data.errors, [], "global loading errors must fail");
  const specs = [];
  function visit(suites) {
    for (const suite of suites || []) { specs.push(...(suite.specs || [])); visit(suite.suites); }
  }
  visit(data.suites);
  const names = ["local page fetches and displays the API response", "two browser contexts keep client state isolated"];
  assert.deepEqual(specs.map(s => s.title), names, "both exact tests must execute");
  for (const [index, spec] of specs.entries()) {
    assert.equal(spec.tests.length, 1);
    const test = spec.tests[0];
    assert.equal(test.results.length, 1, "no retry may hide failure");
    const result = test.results[0];
    const intentional = negative && index === 0;
    assert.equal(result.status, intentional ? "failed" : "passed");
    assert.equal(result.errors.length, intentional ? 1 : 0);
    if (intentional) {
      const message = result.errors[0].message.replace(/\x1b\[[0-9;]*m/g, "");
      assert.match(message, /expect\(locator\)\.toHaveText/);
      assert.match(message, /Expected: "broken"/);
      assert.match(message, /Received: "ok"/);
      assert.ok(result.attachments.some(a => a.name === "trace" && fs.existsSync(a.path)), "failure trace required");
    }
  }
  assert.equal(data.stats.expected, negative ? 1 : 2);
  assert.equal(data.stats.unexpected, negative ? 1 : 0);
  assert.equal(data.stats.skipped, 0);
  assert.equal(data.stats.flaky, 0);
}
function k6(data, negative) {
  assert.equal(data.trial.base_url, "http://127.0.0.1:3100");
  assert.equal(data.metrics.http_req_failed.values.rate, 0);
  const count = data.metrics.http_reqs.values.count;
  assert.ok(count > 0);
  const checks = data.root_group.checks;
  assert.deepEqual(checks.map(c => c.name).sort(), ["HTTP status matches expectation", "JSON status is ok"].sort());
  for (const check of checks) {
    const intentional = negative && check.name === "HTTP status matches expectation";
    assert.equal(check.passes, intentional ? 0 : count);
    assert.equal(check.fails, intentional ? count : 0);
  }
  assert.equal(data.metrics.checks.thresholds["rate==1"].ok, !negative);
  assert.equal(data.metrics.http_req_failed.thresholds["rate==0"].ok, true);
}
function junit(file, count, failures) {
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
  const data = parser.parse(fs.readFileSync(file, "utf8"));
  const suites = data.testsuites?.testsuite || data.testsuite;
  const all = Array.isArray(suites) ? suites : [suites];
  assert.ok(all.every(Boolean), "JUnit suite missing");
  assert.equal(all.reduce((n, s) => n + Number(s.tests), 0), count);
  assert.equal(all.reduce((n, s) => n + Number(s.failures || 0), 0), failures);
  assert.equal(all.reduce((n, s) => n + Number(s.errors || 0), 0), 0);
  assert.equal(all.reduce((n, s) => n + Number(s.skipped || 0), 0), 0);
}
function validateReport(name, reports) {
  const data = JSON.parse(fs.readFileSync(path.join(reports, name + ".json"), "utf8"));
  const negative = name.endsWith("negative");
  if (name.startsWith("bruno")) {
    const poc = name === "bruno-poc";
    bruno(data, negative, poc);
    junit(path.join(reports, name + ".xml"), poc ? 20 : 2, negative ? 1 : 0);
  } else if (name.startsWith("playwright")) {
    playwright(data, negative);
    junit(path.join(reports, name + ".xml"), 2, negative ? 1 : 0);
  } else k6(data, negative);
}
module.exports = { validateReport, bruno, playwright, k6 };
