const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const { cases } = require("./collection/plan.cjs");
const {
  specs,
  responseSchema,
  validateResponse,
} = require("./collection/schema.cjs");
const { redact } = require("./report.cjs");
const generated = spawnSync(process.execPath, ["generate.cjs", "--check"], {
  cwd: __dirname,
  stdio: "inherit",
});
assert.equal(generated.status, 0);
assert.equal(new Set(cases.map((c) => c.id)).size, cases.length);
for (const [api, spec] of Object.entries(specs))
  for (const [route, ops] of Object.entries(spec.paths))
    for (const method of Object.keys(ops).filter((m) =>
      ["get", "post", "put", "patch", "delete"].includes(m),
    )) {
      assert.ok(
        cases.some(
          (c) =>
            c.api === api &&
            c.route === route &&
            c.method === method &&
            !c.transport &&
            c.status < 300,
        ),
        "uncovered operation " + method + " " + route,
      );
    }
for (const [api, spec] of Object.entries(specs))
  for (const [route, ops] of Object.entries(spec.paths))
    for (const [method, op] of Object.entries(ops))
      for (const status of Object.keys(op.responses || {}))
        assert.ok(
          cases.some(
            (c) =>
              c.api === api &&
              c.route === route &&
              c.method === method &&
              String(c.status) === status &&
              !c.transport,
          ),
          "uncovered response " + method + " " + route + " " + status,
        );
for (const c of cases)
  if (!c.transport) responseSchema(c.api, c.route, c.method, c.status);
const user = {
  id: "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0",
  username: "Test",
  created_at: "2026-11-18T12:00:00Z",
};
const headers = { "content-type": "application/json" };
validateResponse("auth", "/me", "get", 200, user, headers);
for (const mutation of [
  { ...user, id: "bad" },
  { ...user, created_at: "invalid" },
  { ...user, extra: true },
  { username: "Test" },
])
  assert.throws(() =>
    validateResponse("auth", "/me", "get", 200, mutation, headers),
  );
validateResponse("auth", "/contacts/{contact_id}", "put", 204, "");
assert.throws(() =>
  validateResponse("auth", "/contacts/{contact_id}", "put", 204, {}),
);
const token = {
  token_type: "Bearer",
  access_token: "test-only",
  expires_in: 900,
};
validateResponse("auth", "/auth/login", "post", 200, token, headers);
assert.throws(() =>
  validateResponse(
    "auth",
    "/auth/login",
    "post",
    200,
    { ...token, expires_in: "900" },
    headers,
  ),
);
assert.equal(
  redact(
    "Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.c2lnbmF0dXJl refresh_token=opaque; password",
    ["password"],
  ),
  "Bearer [JWT REDACTED] refresh_token=[REDACTED]; [REDACTED]",
);
console.log(
  `All OpenAPI operations covered by ${cases.length} requests; schema rejection, 204 and redaction controls passed`,
);

const fs = require("node:fs"),
  path = require("node:path");
const workflow = require("yaml").parse(
  fs.readFileSync(
    path.resolve(
      __dirname,
      "../../../.github/workflows/api-contract-tests.yml",
    ),
    "utf8",
  ),
);
const steps = workflow.jobs.contracts.steps;
const verifier = steps.find((s) => s.id === "verify_reports"),
  upload = steps.find((s) => s.uses?.startsWith("actions/upload-artifact@"));
assert.equal(verifier.run, "npm run check:reports");
assert.ok(steps.indexOf(upload) > steps.indexOf(verifier));
assert.match(upload.if, /steps\.verify_reports\.outcome == 'success'/);
assert.ok(!upload.if.includes("always()"));
console.log("Artifact upload requires successful content verification");
