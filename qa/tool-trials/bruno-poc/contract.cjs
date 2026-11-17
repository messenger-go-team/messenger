const fs = require("node:fs");
const path = require("node:path");
const YAML = require("yaml");
const Ajv2020 = require("ajv/dist/2020");
const addFormats = require("ajv-formats");
// Read the checked-out contract on every run; no copied schema can silently drift.
const contractPath = path.resolve(__dirname, "../../../api/openapi/auth.yaml");
const contract = YAML.parse(fs.readFileSync(contractPath, "utf8"));
if (contract.openapi !== "3.1.0") throw new Error("Reassess validator for changed OpenAPI version");
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);
// OpenAPI annotation: documentation only, deliberately no validation semantics.
ajv.addKeyword({ keyword: "example", valid: true });
function responseValidator(route, method, status) {
  let response = contract.paths[route][method].responses[String(status)];
  if (response.$ref) {
    response = response.$ref.slice(2).split("/").reduce((value, key) => value[key], contract);
  }
  const schema = response.content["application/json"].schema;
  return ajv.compile({ $schema: "https://json-schema.org/draft/2020-12/schema",
    ...schema, components: contract.components });
}
// components is a reference container, not a validation keyword.
ajv.addKeyword({ keyword: "components", schemaType: "object" });
module.exports = { responseValidator };
