const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { verify } = require("./report.cjs");
const dir = path.join(__dirname, "reports/public");
const positive = JSON.parse(fs.readFileSync(path.join(dir, "positive.json")));
const negative = JSON.parse(fs.readFileSync(path.join(dir, "negative.json")));
verify(positive);
verify(negative, "AUTH-LOGIN");
assert.equal(
  fs.existsSync(path.join(__dirname, "reports/fixture.json")),
  false,
  "fixture credentials must be removed",
);
for (const data of [positive, negative])
  for (const result of data[0].results) {
    for (const message of [result.request, result.response]) {
      assert.ok(
        !Object.hasOwn(message, "body"),
        "body omitted from public report",
      );
      assert.deepEqual(
        message.headers,
        {},
        "headers omitted from public report",
      );
    }
  }

const expectedFiles = ["positive", "negative"].flatMap((n) =>
  ["json", "xml", "log", "summary.json"].map((ext) => n + "." + ext),
);
assert.deepEqual(
  fs.readdirSync(dir).sort(),
  expectedFiles.sort(),
  "only verified artifacts allowed",
);
for (const file of fs.readdirSync(dir)) {
  const text = fs.readFileSync(path.join(dir, file), "utf8");
  assert.doesNotMatch(
    text,
    /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/,
  );
  assert.doesNotMatch(text, /refresh_token=(?!\[REDACTED\])[^;\s"'<,]+/);
  for (const secret of [
    "T49-fixture-password-only",
    "api-fixture-only",
    "t49-internal-test-only-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  ])
    assert.ok(!text.includes(secret), "secret in public report");
}
for (const mutate of [
  (d) => d[0].results.pop(),
  (d) => (d[0].results[0].error = "load failure"),
  (d) => d[0].results[0].testResults.pop(),
  (d) => (d[0].results[0].testResults[0].status = "fail"),
  (d) => (d[0].results[0].response.status = 503),
  (d) => (d[0].summary.failedTests = 0),
]) {
  const copy = structuredClone(negative);
  mutate(copy);
  assert.throws(() => verify(copy, "AUTH-LOGIN"));
}
const wrong = structuredClone(negative);
const t = wrong[0].results
  .flatMap((r) => r.testResults)
  .find((t) => t.status === "fail");
t.error = "Cannot load script";
assert.throws(() => verify(wrong, "AUTH-LOGIN"));
assert.throws(() => verify(positive, "AUTH-LOGIN"));
assert.throws(() => verify(negative));
console.log(
  "Positive/negative reports verified; load failures, missing checks and unrelated failures rejected",
);
