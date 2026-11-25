// Real HTTPS + pinned Bruno: token revocation must not hide a retained cookie.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const https = require("node:https");
const { spawn, spawnSync } = require("node:child_process");
const { renderRequest } = require("./generate.cjs");

async function logoutControl() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-logout-"));
  let server;
  try {
    const candidates =
      process.platform === "win32"
        ? [
            "openssl",
            "C:/Program Files/Git/usr/bin/openssl.exe",
            "C:/Program Files/Git/mingw64/bin/openssl.exe",
          ]
        : ["openssl"];
    const openssl = candidates.find(
      (bin) => spawnSync(bin, ["version"], { windowsHide: true }).status === 0,
    );
    assert.ok(
      openssl,
      "HTTPS cookie control requires OpenSSL (Git for Windows or system package)",
    );
    const cert = path.join(tmp, "cert.pem"),
      key = path.join(tmp, "key.pem");
    const issued = spawnSync(
      openssl,
      [
        "req",
        "-x509",
        "-newkey",
        "rsa:2048",
        "-nodes",
        "-keyout",
        key,
        "-out",
        cert,
        "-days",
        "1",
        "-subj",
        "/CN=localhost",
        "-addext",
        "subjectAltName=IP:127.0.0.1,DNS:localhost",
      ],
      { windowsHide: true, encoding: "utf8" },
    );
    assert.equal(issued.status, 0, "issue local HTTPS certificate");
    fs.chmodSync(key, 0o600);
    let deletePath = "/auth",
      revoked = false,
      refreshCookies = [];
    server = https.createServer(
      { key: fs.readFileSync(key), cert: fs.readFileSync(cert) },
      (req, res) => {
        req.resume();
        if (req.url === "/auth/login") {
          res.writeHead(200, {
            "Content-Type": "application/json",
            "Set-Cookie":
              "refresh_token=control-only; Path=/auth; HttpOnly; Secure; SameSite=Lax",
          });
          res.end("{}");
        } else if (req.url === "/auth/logout") {
          revoked = true;
          res.writeHead(204, {
            "Set-Cookie": `refresh_token=; Path=${deletePath}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`,
          });
          res.end();
        } else if (req.url === "/auth/refresh") {
          assert.equal(revoked, true);
          refreshCookies.push(
            (req.headers.cookie || "").includes("refresh_token=control-only"),
          );
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end('{"code":"unauthorized","message":"revoked"}');
        } else {
          res.writeHead(404);
          res.end();
        }
      },
    );
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const baseUrl = "https://127.0.0.1:" + server.address().port;
    fs.mkdirSync(path.join(tmp, "environments"));
    fs.writeFileSync(
      path.join(tmp, "bruno.json"),
      JSON.stringify({
        version: "1",
        name: "Logout cookie control",
        type: "collection",
      }),
    );
    fs.writeFileSync(
      path.join(tmp, "environments/control.bru"),
      `vars {\n  baseUrl: ${baseUrl}\n}\n`,
    );
    for (const file of ["plan.cjs", "invariants.cjs", "receipts.cjs"])
      fs.copyFileSync(
        path.join(__dirname, "collection", file),
        path.join(tmp, file),
      );
    const plan = JSON.stringify("./plan.cjs");
    const invariants = JSON.stringify("./invariants.cjs");
    fs.writeFileSync(
      path.join(tmp, "support.cjs"),
      `
const {cases}=require(${plan});
const {readRefreshJar}=require(${invariants});
exports.prepare=async(id,bru,req)=>{
 const c=cases.find(c=>c.id===id);
 if(c?.captureRefreshJar)bru.setVar(id+"-refreshJar",await readRefreshJar(bru,bru.getEnvVar("baseUrl")));
 if(c?.clearCookies)await bru.cookies.jar().clear();
 if(c?.headers?.Cookie)req.setHeader("Cookie",bru.getVar("lastRefresh"));
};
exports.verify=(id,bru,req,res,test,expect)=>{
 const c=cases.find(c=>c.id===id);
 test(id+" status",()=>expect(res.status).equal(c?.status??200));
 test(id+" semantics",()=>{
   if(id==="LOGIN-CONTROL")bru.setVar("lastRefresh","refresh_token=control-only");
   else if(c.check)c.check({v:bru,res,e:expect});
 });
};
`,
    );
    const { cases } = require("./collection/plan.cjs");
    const selected = [
      { id: "LOGIN-CONTROL", method: "post", path: "/auth/login" },
      ...[
        "AUTH-LOGOUT",
        "AUTH-REFRESH-NO-COOKIE",
        "AUTH-LOGOUT-REVOKED-REFRESH",
      ].map((id) => cases.find((c) => c.id === id)),
    ];
    selected.forEach((c, i) =>
      fs.writeFileSync(path.join(tmp, `${i + 1}.bru`), renderRequest(c, i)),
    );
    for (const invalid of [false, true]) {
      deletePath = invalid ? "/" : "/auth";
      revoked = false;
      refreshCookies = [];
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
              NODE_EXTRA_CA_CERTS: cert,
              NODE_TLS_REJECT_UNAUTHORIZED: "1",
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
      assert.ok(!result.error, "launch Bruno HTTPS control");
      assert.equal(result.code, invalid ? 1 : 0, result.output);
      const [run] = JSON.parse(fs.readFileSync(report, "utf8"));
      assert.equal(run.summary.totalRequests, 4);
      assert.equal(run.summary.errorRequests, 0);
      assert.equal(run.summary.totalTests, 8);
      assert.equal(run.summary.failedTests, invalid ? 2 : 0);
      const failures = [];
      for (const r of run.results) {
        assert.equal(r.error, null);
        assert.deepEqual(r.assertionResults, []);
        assert.deepEqual(r.preRequestTestResults || [], []);
        assert.deepEqual(r.postResponseTestResults || [], []);
        assert.equal(r.testResults.length, 2);
        for (const t of r.testResults)
          if (t.status !== "pass") failures.push(t);
      }
      assert.deepEqual(
        failures.map((t) => t.description).sort(),
        invalid
          ? ["AUTH-LOGOUT semantics", "AUTH-REFRESH-NO-COOKIE semantics"]
          : [],
      );
      if (invalid) {
        assert.match(
          failures.find((t) => t.description === "AUTH-LOGOUT semantics").error,
          /logout refresh Path=\/auth/,
        );
        assert.match(
          failures.find(
            (t) => t.description === "AUTH-REFRESH-NO-COOKIE semantics",
          ).error,
          /refresh cookie must be absent after logout before manual clear/,
        );
      }
      assert.deepEqual(
        refreshCookies,
        [invalid, true],
        "jar request then explicit revoked-token replay",
      );
    }
    console.log(
      "Bruno HTTPS logout control: Path=/auth clears jar; Path=/ retains cookie and fails both deletion checks despite 401; explicit revoked-token replay remains 401",
    );
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    assert.equal(path.dirname(tmp), os.tmpdir());
    assert.ok(path.basename(tmp).startsWith("messenger-logout-"));
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
if (require.main === module)
  logoutControl().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
module.exports = { logoutControl };
