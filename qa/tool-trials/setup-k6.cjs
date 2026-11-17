const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const version = "2.4.0";
const checksum = "aaa90b3afc336faf90172c7addf45c4f41305f6f188e3d564f79466e80ac68e3";
async function main() {
  if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("This installer supports Windows amd64; install k6 2.4.0 manually and set K6_BIN.");
  }
  const tools = path.join(__dirname, ".tools");
  const filename = `k6-v${version}-windows-amd64.zip`;
  const archive = path.join(tools, filename);
  await fs.mkdir(tools, { recursive: true });
  const response = await fetch(`https://github.com/grafana/k6/releases/download/v${version}/${filename}`,
    { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (crypto.createHash("sha256").update(bytes).digest("hex") !== checksum) {
    throw new Error("k6 checksum mismatch");
  }
  await fs.writeFile(archive, bytes);
  const extracted = spawnSync("tar.exe", ["-xf", archive, "-C", tools], {
    stdio: "inherit", windowsHide: true
  });
  if (extracted.error) throw extracted.error;
  if (extracted.status !== 0) throw new Error("k6 archive extraction failed");
  const checked = spawnSync(path.join(tools, `k6-v${version}-windows-amd64`, "k6.exe"), ["version"],
    { stdio: "inherit", windowsHide: true });
  if (checked.error) throw checked.error;
  if (checked.status !== 0) throw new Error("k6 version check failed");
  console.log("Official archive SHA256 verified; local k6 installation ready.");
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
