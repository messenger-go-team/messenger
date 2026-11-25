const assert = require("node:assert/strict");
const { faker } = require("@faker-js/faker");
const { parse } = require("csv-parse/sync");
const { globSync } = require("glob");
const { minimatch } = require("minimatch");
const { v4, validate } = require("uuid");
assert.match(faker.helpers.fake("{{string.uuid}}"), /^[a-f0-9-]{36}$/);
assert.deepEqual(parse("probe\nT49-local-only\n", { columns: true }), [
  { probe: "T49-local-only" },
]);
assert.ok(globSync("collection/*.bru", { cwd: __dirname }).length > 100);
assert.equal(minimatch("collection/request.bru", "collection/*.bru"), true);
assert.ok(validate(v4()));
assert.equal(require("js-yaml").load("probe: ok").probe, "ok");
assert.equal(require("yaml").parse("probe: ok").probe, "ok");
const form = new (require("form-data"))();
form.append("probe", "ok");
assert.match(form.getBuffer().toString(), /name="probe"/);
assert.equal(typeof require("axios").create().get, "function");
console.log(
  "Dependency API compatibility controls passed (HTTP collection scope)",
);
