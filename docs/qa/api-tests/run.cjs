const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { spawnSync } = require("node:child_process");
const { verify, redact } = require("./report.cjs");
const root = __dirname;
function command(binary, args, cwd = root) {
  const r = spawnSync(binary, args, {
    cwd,
    env: {
      ...process.env,
      ...(binary.endsWith("/migrate")
        ? {
            POSTGRES_HOST: "postgres",
            POSTGRES_PORT: "5432",
            POSTGRES_USER: "postgres",
            POSTGRES_PASSWORD: "api-fixture-only",
            POSTGRES_DB: args.includes("-service=auth")
              ? "api_auth"
              : "api_history",
            POSTGRES_SSLMODE: "disable",
          }
        : {}),
    },
    encoding: "utf8",
    timeout: 180000,
  });
  if (r.status !== 0)
    throw new Error("test setup command failed: " + path.basename(binary));
}
async function ready() {
  for (let i = 0; i < 90; i++) {
    try {
      const replies = await Promise.all(
        [
          "http://auth:8080/readyz",
          "http://history:8080/readyz",
          "https://gateway:8443/me",
        ].map((url) => fetch(url, { signal: AbortSignal.timeout(1000) })),
      );
      if (
        replies[0].status === 200 &&
        replies[1].status === 200 &&
        replies[2].status === 401
      )
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("isolated API environment did not become ready");
}
async function main() {
  if (process.argv.includes("--init")) {
    for (const service of ["auth", "history"])
      command(
        "/usr/local/bin/migrate",
        ["-service=" + service, "-direction=up"],
        "/workspace",
      );
    command("/usr/local/bin/api-fixture", ["grants"]);
    return;
  }
  if (
    process.env.API_REPORT_DIR !== "/reports" ||
    process.env.FIXTURE_BIN !== "/usr/local/bin/api-fixture"
  )
    throw new Error("Run T49 through its private Compose environment");
  const negative = process.env.NEGATIVE_SCHEMA_CASE || "";
  if (negative && negative !== "AUTH-LOGIN")
    throw new Error("unknown negative control");
  const name = negative ? "negative" : "positive";
  const reports = path.join(process.env.API_REPORT_DIR, "public");
  fs.mkdirSync(reports, { recursive: true });
  // Clear artifacts for THIS run before starting; a load failure cannot reuse a green report.
  for (const ext of ["json", "xml", "log", "summary.json"])
    fs.rmSync(path.join(reports, name + "." + ext), { force: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "messenger-api-"));
  let secrets = [
    process.env.AUTH_DATABASE_URL,
    process.env.HISTORY_DATABASE_URL,
    process.env.AUTH_INTERNAL_TOKEN,
    "T49-fixture-password-only",
  ];
  try {
    await ready();
    command(process.env.FIXTURE_BIN, ["reset"]);
    command(process.env.FIXTURE_BIN, ["bootstrap"]);
    const fixture = JSON.parse(
      fs.readFileSync(path.join(process.env.API_REPORT_DIR, "fixture.json")),
    );
    secrets.push(
      ...["aToken", "bToken", "cToken", "expiredToken"].map((k) => fixture[k]),
    );
    const result = spawnSync(
      process.execPath,
      [
        path.join(root, "node_modules/@usebruno/cli/bin/bru.js"),
        "run",
        "--csv-file-path",
        "compatibility.csv",
        "--env",
        "compose",
        "--sandbox",
        "developer",
        "--experimental-cache-modules",
        "--cacert",
        "/certs/ca.pem",
        "--reporter-json",
        path.join(tmp, "result.json"),
        "--reporter-junit",
        path.join(tmp, "result.xml"),
        "--reporter-skip-all-headers",
        "--reporter-skip-body",
      ],
      {
        cwd: path.join(root, "collection"),
        encoding: "utf8",
        timeout: 600000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          HTTP_PROXY: "",
          HTTPS_PROXY: "",
          ALL_PROXY: "",
          NO_PROXY: "*",
          FORCE_COLOR: "0",
        },
      },
    );
    const output = redact(
      (result.stdout || "") + (result.stderr || ""),
      secrets,
    );
    fs.writeFileSync(path.join(reports, name + ".log"), output);
    process.stdout.write(output.slice(-1600));
    for (const ext of ["json", "xml"]) {
      const file = path.join(tmp, "result." + ext);
      if (fs.existsSync(file))
        fs.writeFileSync(
          path.join(reports, name + "." + ext),
          redact(fs.readFileSync(file, "utf8"), secrets),
        );
    }
    if (result.error)
      throw new Error("Bruno failed to execute: " + result.error.code);
    if (result.status !== (negative ? 1 : 0))
      throw new Error(
        "Unexpected Bruno exit code " + result.status + "; see sanitized log",
      );
    const data = JSON.parse(
      fs.readFileSync(path.join(tmp, "result.json"), "utf8"),
    );
    verify(data, negative);
    const summary = {
      date_utc: new Date().toISOString(),
      mode: name,
      node: process.version,
      bruno: require("@usebruno/cli/package.json").version,
      expected_exit: negative ? 1 : 0,
      actual_exit: result.status,
      ...data[0].summary,
      report_verified: true,
    };
    fs.writeFileSync(
      path.join(reports, name + ".summary.json"),
      JSON.stringify(summary, null, 2) + "\n",
    );
    console.log(
      `${name}: all ${data[0].summary.totalRequests} requests and their exact results verified`,
    );
  } finally {
    fs.rmSync(path.join(process.env.API_REPORT_DIR, "fixture.json"), {
      force: true,
    });
    // tmp is a directory created by this process, never a user-supplied path.
    if (
      path.dirname(tmp) !== os.tmpdir() ||
      !path.basename(tmp).startsWith("messenger-api-")
    )
      throw new Error("unexpected temporary path");
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
main().catch((error) => {
  console.error(redact(error.message));
  process.exitCode = 1;
});
