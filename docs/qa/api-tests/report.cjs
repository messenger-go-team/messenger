const assert = require("node:assert/strict");
const { cases } = require("./collection/plan.cjs");
function verify(data, negative = "") {
  assert.equal(data.length, 1, "one collection iteration");
  const run = data[0];
  assert.equal(run.results.length, cases.length, "request count");
  for (const [i, c] of cases.entries()) {
    const r = run.results[i];
    assert.equal(r.name, c.id, "request order/name");
    assert.equal(r.error, null, "request/script error");
    assert.equal(r.response.status, c.status, "recorded HTTP status");
    assert.deepEqual(r.assertionResults, []);
    assert.deepEqual(r.preRequestTestResults || [], []);
    assert.deepEqual(r.postResponseTestResults || [], []);
    assert.deepEqual(
      r.testResults.map((t) => t.description).sort(),
      [c.id + " status", c.id + " OpenAPI", c.id + " semantics"].sort(),
    );
    for (const t of r.testResults) {
      const intentional =
        c.id === negative && t.description === negative + " OpenAPI";
      assert.equal(
        t.status,
        intentional ? "fail" : "pass",
        t.description + ": " + (t.error || ""),
      );
      if (intentional) {
        assert.match(t.error, /OpenAPI response mismatch/);
        assert.match(t.error, /expires_in/);
      } else assert.ok(!t.error, t.description);
    }
  }
  assert.equal(run.summary.totalRequests, cases.length);
  assert.equal(run.summary.passedRequests, cases.length - (negative ? 1 : 0));
  assert.equal(run.summary.failedRequests, negative ? 1 : 0);
  assert.equal(run.summary.skippedRequests, 0);
  assert.equal(run.summary.errorRequests, 0);
  assert.equal(run.summary.totalTests, cases.length * 3);
  assert.equal(run.summary.failedTests, negative ? 1 : 0);
  assert.equal(run.summary.passedTests, cases.length * 3 - (negative ? 1 : 0));
}
function redact(value, secrets = []) {
  let text = String(value)
    .replace(
      /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
      "[JWT REDACTED]",
    )
    .replace(/refresh_token=[^;\s"'<,]+/g, "refresh_token=[REDACTED]");
  for (const secret of secrets.filter(Boolean))
    text = text.split(secret).join("[REDACTED]");
  return text;
}
module.exports = { verify, redact };
