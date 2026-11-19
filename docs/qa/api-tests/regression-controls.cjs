// Regression controls exercise the production generator and case callbacks.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const http = require("node:http");
const vm = require("node:vm");
const otherRealm = (value) =>
  vm.runInNewContext("(" + JSON.stringify(value) + ")");
const { spawn } = require("node:child_process");
const { cases } = require("./collection/plan.cjs");
const { validateResponse } = require("./collection/schema.cjs");
const { assertUnchangedLater } = require("./collection/invariants.cjs");
const { renderRequest } = require("./generate.cjs");

function semanticControls() {
  const complete =
    "refresh_token=rotated; Path=/auth; HttpOnly; Secure; SameSite=Lax";
  for (const id of ["AUTH-REFRESH", "AUTH-NEW-REFRESH"]) {
    const check = cases.find((c) => c.id === id).check;
    function run(header) {
      const vars = { r1: "refresh_token=old1", r2: "refresh_token=old2" };
      check({
        b: { access_token: "fake-test-token" },
        v: { getVar: (k) => vars[k], setVar: (k, v) => (vars[k] = v) },
        res: { headers: { "set-cookie": [header] } },
      });
      return vars;
    }
    run(complete);
    for (const flag of ["HttpOnly", "Secure", "SameSite=Lax", "Path=/auth"])
      assert.throws(
        () => run(complete.replace("; " + flag, "")),
        /refresh (HttpOnly|Secure|SameSite|Path)/,
        id + " must reject missing " + flag,
      );
  }
  const replay = cases.find((c) => c.id === "AUTH-LOGOUT-REVOKED-REFRESH");
  assert.equal(replay.status, 401);
  assert.equal(replay.headers.Cookie, "{{lastRefresh}}");
  assert.equal(replay.clearCookies, true);

  const before = [
    {
      id: "entry",
      user_id: "owner",
      message_id: "source",
      due_at: null,
      state: "active",
      created_at: "2026-01-01T00:00:00Z",
      updated_at: "2026-01-01T00:00:00Z",
    },
  ];
  assertUnchangedLater(before, structuredClone(before));
  assertUnchangedLater(before, otherRealm(before));
  for (const mutate of [
    (x) => (x[0].due_at = "2099-01-01T00:00:00Z"),
    (x) => (x[0].state = "done"),
    (x) => (x[0].updated_at = "2026-01-02T00:00:00Z"),
    (x) => x.pop(),
    (x) => x.push({ ...x[0], id: "other" }),
  ]) {
    const after = structuredClone(before);
    mutate(after);
    assert.throws(
      () => assertUnchangedLater(before, after),
      /Later state changed/,
    );
  }
  const queries = ["limit=1", "unexpected=1", "due_at=%zz", "%zz=1", "%"];
  const ops = [
    ["post", "/later"],
    ["get", "/later"],
    ["patch", "/later/{later_id}"],
    ["post", "/later/{later_id}/done"],
  ];
  for (const [method, route] of ops)
    for (const q of queries) {
      for (const auth of ["none", "invalid", "expired"])
        assert.ok(
          cases.some(
            (c) =>
              c.method === method &&
              c.route === route &&
              c.path.endsWith("?" + q) &&
              c.status === 401 &&
              c.auth === auth &&
              c.unchangedLater,
          ),
          "auth/query precedence and snapshot required",
        );
      assert.ok(
        cases.some(
          (c) =>
            c.method === method &&
            c.route === route &&
            c.path.endsWith("?" + q) &&
            c.status === 422 &&
            c.unchangedLater,
        ),
        "query rejection snapshot required",
      );
    }
  for (const c of cases.filter((c) => c.id.startsWith("LATER-CREATE-QUERY-")))
    assert.equal(c.unchangedLater, true);

  const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
  const f = {
    chatAB: uuid(1000),
    targetID: uuid(150),
    firstID: uuid(1),
    lastID: uuid(205),
  };
  const fixtures = [
    ["CONTEXT-1", 150, 150, true, true, 150],
    ["CONTEXT-3", 149, 151, true, true, 150],
    ["CONTEXT-100", 101, 200, true, true, 150],
    ["CONTEXT-DEFAULT", 126, 175, true, true, 150],
    ["CONTEXT-EDGE-FIRST-1", 1, 1, false, true, 1],
    ["CONTEXT-EDGE-FIRST-3", 1, 2, false, true, 1],
    ["CONTEXT-EDGE-FIRST-100", 1, 51, false, true, 1],
    ["CONTEXT-EDGE-LAST-1", 205, 205, true, false, 205],
    ["CONTEXT-EDGE-LAST-3", 204, 205, true, false, 205],
    ["CONTEXT-EDGE-LAST-100", 156, 205, true, false, 205],
  ];
  const make = (first, last, target, before, after) => ({
    target_message_id: uuid(target),
    messages: Array.from({ length: last - first + 1 }, (_, i) => {
      const seq = first + i;
      return {
        id: uuid(seq),
        chat_id: f.chatAB,
        sender_id: uuid(2000),
        seq,
        body: "control",
        created_at: "2026-01-01T00:00:00Z",
      };
    }),
    next_before_seq: first,
    next_after_seq: last,
    has_more_before: before,
    has_more_after: after,
  });
  for (const [id, first, last, before, after, target] of fixtures) {
    const c = cases.find((c) => c.id === id),
      body = make(first, last, target, before, after);
    validateResponse("history", c.route, "get", 200, body, {
      "content-type": "application/json",
    });
    c.check({ b: body, f });
    c.check({ b: otherRealm(body), f });
    for (const [field, value] of [
      ["next_before_seq", first + 1],
      ["next_after_seq", last + 1],
      ["has_more_before", !before],
      ["has_more_after", !after],
    ]) {
      const bad = { ...body, [field]: value };
      assert.throws(() => c.check({ b: bad, f }), /context/);
    }
  }
  const middle = cases.find((c) => c.id === "CONTEXT-100"),
    bad = make(100, 199, 150, false, false);
  validateResponse("history", middle.route, "get", 200, bad, {
    "content-type": "application/json",
  });
  assert.throws(() => middle.check({ b: bad, f }), /context exact seq window/);
  for (const [id, body] of [
    ["CONTEXT-EDGE-FIRST-100", make(1, 100, 1, false, true)],
    ["CONTEXT-EDGE-LAST-100", make(106, 205, 205, true, false)],
  ])
    assert.throws(
      () => cases.find((c) => c.id === id).check({ b: body, f }),
      /context exact seq window/,
    );
  console.log(
    "Refresh attributes, retained logout token, Later side effects/auth precedence and Context regression controls passed",
  );
}

async function redirectControl() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-redirect-"));
  let targetHits = 0,
    redirectHits = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    assert.equal(req.method, "POST");
    if (req.url === "/redirect") {
      redirectHits++;
      res.writeHead(307, { Location: "/target" });
      res.end();
    } else if (req.url === "/target") {
      targetHits++;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = "http://127.0.0.1:" + server.address().port;
    fs.mkdirSync(path.join(tmp, "environments"));
    fs.writeFileSync(
      path.join(tmp, "bruno.json"),
      JSON.stringify({
        version: "1",
        name: "T49 redirect guard",
        type: "collection",
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "environments/control.bru"),
      "vars {\n  baseUrl: " + url + "\n}\n",
    );
    fs.writeFileSync(
      path.join(tmp, "support.cjs"),
      'exports.prepare=async()=>{};exports.verify=(id,bru,req,res,test,expect)=>test(id+" status",()=>expect(res.status).equal(200));',
    );
    async function run(route, expectedExit, expectedHTTP) {
      const c = {
        id: "REDIRECT-CONTROL",
        method: "post",
        path: route,
        body: { probe: true },
      };
      fs.writeFileSync(path.join(tmp, "request.bru"), renderRequest(c, 0));
      const report = path.join(tmp, "result.json");
      fs.rmSync(report, { force: true });
      const result = await new Promise((resolve) => {
        const child = spawn(
          process.execPath,
          [
            path.join(__dirname, "node_modules/@usebruno/cli/bin/bru.js"),
            "run",
            "--env",
            "control",
            "--sandbox",
            "developer",
            "--reporter-json",
            report,
            "--reporter-skip-all-headers",
            "--reporter-skip-body",
          ],
          {
            cwd: tmp,
            windowsHide: true,
            env: {
              ...process.env,
              HTTP_PROXY: "",
              HTTPS_PROXY: "",
              ALL_PROXY: "",
              http_proxy: "",
              https_proxy: "",
              all_proxy: "",
              NO_PROXY: "*",
              no_proxy: "*",
              FORCE_COLOR: "0",
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let output = "";
        child.stdout.on("data", (b) => (output += b));
        child.stderr.on("data", (b) => (output += b));
        const timer = setTimeout(() => child.kill(), 60000);
        child.once("error", (error) => {
          clearTimeout(timer);
          resolve({ code: null, error });
        });
        child.once("close", (code) => {
          clearTimeout(timer);
          resolve({ code, output });
        });
      });
      assert.ok(!result.error, "Bruno control launch");
      assert.equal(result.code, expectedExit, result.output);
      const all = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.equal(all.length, 1);
      const d = all[0];
      assert.equal(d.results.length, 1);
      const r = d.results[0];
      assert.equal(r.error, null);
      assert.equal(r.name, c.id);
      assert.equal(r.response.status, expectedHTTP);
      assert.deepEqual(r.assertionResults, []);
      assert.deepEqual(r.preRequestTestResults || [], []);
      assert.deepEqual(r.postResponseTestResults || [], []);
      assert.equal(r.testResults.length, 1);
      const t = r.testResults[0];
      assert.equal(t.description, c.id + " status");
      assert.equal(t.status, expectedExit ? "fail" : "pass");
      if (expectedExit) assert.match(t.error, /expected 307 to equal 200/);
      else assert.ok(!t.error);
      assert.equal(d.summary.errorRequests, 0);
      assert.equal(d.summary.totalRequests, 1);
      assert.equal(d.summary.totalTests, 1);
      assert.equal(d.summary.failedTests, expectedExit);
    }
    await run("/target", 0, 200);
    assert.equal(targetHits, 1);
    targetHits = 0;
    await run("/redirect", 1, 307);
    assert.equal(redirectHits, 1);
    assert.equal(targetHits, 0, "redirect destination must not be requested");
    console.log(
      "Bruno redirect control: direct POST 200 passes; generated POST 307 fails without following Location",
    );
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (
      path.dirname(tmp) !== os.tmpdir() ||
      !path.basename(tmp).startsWith("messenger-redirect-")
    )
      throw Error("unexpected control temp path");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
semanticControls();
redirectControl().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
