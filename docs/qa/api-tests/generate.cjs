const fs = require("node:fs");
const path = require("node:path");
const { cases } = require("./collection/plan.cjs");
const root = path.join(__dirname, "collection");
function renderRequest(c, index) {
  const source =
    `meta {
  name: ${c.id}
  type: http
  seq: ${index + 1}
}

${c.method} {
  url: {{${c.internal ? "internalUrl" : "baseUrl"}}}${c.path}
  body: ${c.body === undefined ? "none" : "json"}
  auth: none
}

settings {
  followRedirects: false
}
` +
    (c.body === undefined
      ? ""
      : `
headers {
  Content-Type: application/json
}

body:json {
  ${JSON.stringify(c.body)}
}
`) +
    `
script:pre-request {
  const { prepare } = require("./support.cjs");
  await prepare(${JSON.stringify(c.id)}, bru, req);
}

tests {
  const { verify } = require("./support.cjs");
  verify(${JSON.stringify(c.id)}, bru, req, res, test, expect);
}
`;
  return source;
}

function generate(check) {
  const files = new Map();
  for (const [index, c] of cases.entries()) {
    const filename =
      String(index + 1).padStart(3, "0") +
      "-" +
      c.id.replace(/[^A-Za-z0-9_-]/g, "_") +
      ".bru";
    files.set(filename, renderRequest(c, index));
  }
  if (check) {
    for (const [file, source] of files) {
      if (
        !fs.existsSync(path.join(root, file)) ||
        fs.readFileSync(path.join(root, file), "utf8") !== source
      )
        throw new Error("Regenerate " + file);
    }
    const actual = fs.readdirSync(root).filter((f) => f.endsWith(".bru"));
    if (actual.length !== files.size)
      throw new Error("stale generated requests");
  } else {
    // Remove only obsolete numbered files owned by this generator.
    for (const file of fs.readdirSync(root))
      if (/^\d{3}-.+\.bru$/.test(file) && !files.has(file))
        fs.rmSync(path.join(root, file));
    for (const [file, source] of files)
      fs.writeFileSync(path.join(root, file), source);
  }
  console.log(
    `${files.size} Bruno requests ${check ? "verified" : "generated"}`,
  );
  return files;
}
if (require.main === module) generate(process.argv.includes("--check"));
module.exports = { renderRequest, generate };
