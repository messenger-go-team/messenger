const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../../../..");
const specs = Object.fromEntries(
  ["auth", "history"].map((name) => [
    name,
    YAML.parse(
      fs.readFileSync(path.join(root, "api/openapi", name + ".yaml"), "utf8"),
    ),
  ]),
);
const ajv = new Ajv2020({
  allErrors: true,
  strict: true,
  validateFormats: true,
});
addFormats(ajv);
ajv.addFormat("int64", { type: "number", validate: Number.isSafeInteger });
for (const keyword of ["example", "components"])
  ajv.addKeyword({ keyword, valid: true });
const cache = new Map();
function resolve(spec, value) {
  while (value?.$ref)
    value = value.$ref
      .slice(2)
      .split("/")
      .reduce((x, k) => x[k], spec);
  return value;
}
function responseSchema(api, route, method, status) {
  const key = [api, route, method, status].join(" ");
  if (cache.has(key)) return cache.get(key);
  const spec = specs[api];
  assert.equal(spec.openapi, "3.1.0");
  const response = resolve(
    spec,
    spec.paths[route][method].responses[String(status)],
  );
  assert.ok(response, "status missing from OpenAPI: " + key);
  const schema = response.content?.["application/json"]?.schema;
  const validate = schema
    ? ajv.compile({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        ...schema,
        components: spec.components,
      })
    : null;
  const result = { response, validate };
  cache.set(key, result);
  return result;
}
function validateResponse(api, route, method, status, body, headers = {}) {
  const { validate } = responseSchema(api, route, method, status);
  if (status === 204) {
    assert.equal(body, "", "204 must have no JSON body");
    return;
  }
  assert.ok(validate, "JSON response schema is missing");
  assert.match(
    String(headers["content-type"] || ""),
    /^application\/json(?:;|$)/i,
  );
  const valid = validate(body);
  assert.ok(
    valid,
    "OpenAPI response mismatch: " + JSON.stringify(validate.errors),
  );
}
module.exports = { specs, resolve, responseSchema, validateResponse };
