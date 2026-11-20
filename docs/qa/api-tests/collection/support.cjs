const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cases } = require("./plan.cjs");
const { validateResponse } = require("./schema.cjs");
const { assertUnchangedLater, readRefreshJar } = require("./invariants.cjs");
function snapshotLater() {
  const r = spawnSync(process.env.FIXTURE_BIN, ["snapshot-later"], {
    encoding: "utf8",
    timeout: 20000,
    maxBuffer: 1024 * 1024,
  });
  if (r.status !== 0) throw new Error("Later snapshot failed");
  return JSON.parse(r.stdout);
}
function data() {
  return JSON.parse(
    fs.readFileSync(
      path.join(process.env.API_REPORT_DIR, "fixture.json"),
      "utf8",
    ),
  );
}
function interpolate(value, bru) {
  if (typeof value === "string")
    return value.replace(/{{([^}]+)}}/g, (_, name) => {
      const value = bru.getVar(name);
      if (value === undefined) throw new Error("missing variable " + name);
      return String(value);
    });
  if (Array.isArray(value)) return value.map((v) => interpolate(v, bru));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, interpolate(v, bru)]),
    );
  return value;
}
async function prepare(id, bru, req) {
  const c = cases.find((c) => c.id === id);
  if (!c) throw new Error("unknown case");
  const f = data();
  if (
    f.baseUrl !== "https://gateway:8443" ||
    f.internalUrl !== "http://auth:8080"
  )
    throw new Error("T49 only accepts its private Compose origins");
  for (const [k, value] of Object.entries(f))
    if (bru.getVar(k) === undefined) bru.setVar(k, value);
  if (c.captureRefreshJar)
    bru.setVar(id + "-refreshJar", await readRefreshJar(bru, f.baseUrl));
  if (c.clearCookies) await bru.cookies.jar().clear();
  if (c.control) {
    const result = spawnSync(process.env.FIXTURE_BIN, [c.control], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 20000,
    });
    if (result.status !== 0)
      throw new Error("fixture control failed: " + c.control);
  }
  if (c.unchangedLater) bru.setVar("laterBefore", snapshotLater());
  req.setUrl(
    interpolate((c.internal ? f.internalUrl : f.baseUrl) + c.path, bru),
  );
  if (c.body !== undefined) req.setBody(interpolate(c.body, bru));
  if (c.auth !== "none") {
    const token =
      c.auth === "service"
        ? process.env.AUTH_INTERNAL_TOKEN
        : c.auth === "invalid"
          ? "invalid-token"
          : c.auth === "expired"
            ? f.expiredToken
            : bru.getVar(c.auth + "Token");
    if (!token) throw new Error("missing credential for " + id);
    req.setHeader("Authorization", "Bearer " + token);
  }
  for (const [name, value] of Object.entries(c.headers || {}))
    req.setHeader(name, interpolate(value, bru));
}
function verify(id, bru, req, res, test, expect) {
  const c = cases.find((c) => c.id === id),
    f = data();
  test(id + " status", () => expect(res.status).equal(c.status));
  test(id + " OpenAPI", () => {
    if (c.transport) {
      expect(String(res.body)).not.include(f.bID);
      return;
    }
    let body = res.body;
    if (process.env.NEGATIVE_SCHEMA_CASE === id)
      body = { ...body, expires_in: "900" };
    validateResponse(c.api, c.route, c.method, c.status, body, res.headers);
  });
  test(id + " semantics", () => {
    if (c.status >= 400 && !c.transport) {
      expect(res.body).have.property("code");
      expect(JSON.stringify(res.body)).not.match(
        /password_hash|token_hash|panic:|SELECT .+ FROM/i,
      );
    }
    if (c.unchangedLater)
      assertUnchangedLater(bru.getVar("laterBefore"), snapshotLater());
    if (c.check) c.check({ b: res.body, e: expect, v: bru, f, req, res });
  });
}
module.exports = { prepare, verify };
