const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const root = __dirname;
const project =
  "qa49-" + Date.now() + "-" + crypto.randomBytes(3).toString("hex");
process.env.API_TEST_IMAGE = "messenger-api-tests:" + project;
const args = ["compose", "-p", project, "-f", path.join(root, "compose.yaml")];
function docker(more, required = true) {
  const r = spawnSync("docker", [...args, ...more], {
    cwd: root,
    stdio: "inherit",
    windowsHide: true,
  });
  if (required && r.status !== 0)
    throw new Error("Docker Compose step failed: " + more[0]);
  return r.status;
}
let failed = false;
try {
  fs.mkdirSync(path.join(root, "reports", "public"), { recursive: true });
  for (const name of ["positive", "negative"])
    for (const ext of ["json", "xml", "log", "summary.json"])
      fs.rmSync(path.join(root, "reports", "public", name + "." + ext), {
        force: true,
      });
  docker(["build"]);
  docker(["up", "-d", "gateway"]);
  docker(["run", "--rm", "--no-deps", "tests"]);
  docker([
    "run",
    "--rm",
    "--no-deps",
    "-e",
    "NEGATIVE_SCHEMA_CASE=AUTH-LOGIN",
    "tests",
  ]);
} catch (error) {
  console.error(error.message);
  failed = true;
} finally {
  docker(
    ["logs", "--no-color", "--tail", "25", "init", "auth", "history"],
    false,
  );
  const cleaned = docker(["down", "--volumes", "--remove-orphans"], false);
  fs.rmSync(path.join(root, "reports", "fixture.json"), { force: true });
  if (cleaned !== 0) failed = true;
}
if (failed) process.exitCode = 1;
