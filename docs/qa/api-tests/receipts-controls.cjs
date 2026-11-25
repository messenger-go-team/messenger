// T137: mutate real case callbacks, including cross-realm Bruno values.
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { cases } = require("./collection/plan.cjs");
const { validateResponse } = require("./collection/schema.cjs");
const uuid = (n) => "00000000-0000-4000-8000-" + String(n).padStart(12, "0");
const f = { chatAB: uuid(1), aID: uuid(2), bID: uuid(3) };
const headers = {
  "cache-control": "no-store",
  "content-type": "application/json",
};
const snapshot = (values) => ({
  chat_id: f.chatAB,
  members: [f.aID, f.bID].map((user_id, i) => ({
    user_id,
    last_delivered_seq: values[i][0],
    last_read_seq: values[i][1],
  })),
});
function run(id, body, responseHeaders = headers) {
  validateResponse(
    "history",
    "/chats/{chat_id}/receipts",
    "get",
    200,
    body,
    responseHeaders,
  );
  cases
    .find((c) => c.id === id)
    .check({ b: body, f, res: { headers: responseHeaders } });
}
const zero = snapshot([
  [0, 0],
  [0, 0],
]);
const advanced = snapshot([
  [80, 42],
  [7, 3],
]);
run("RECEIPTS-INITIAL-AFTER-REST-READ", zero);
run("RECEIPTS-ADVANCED-A", advanced);
run("RECEIPTS-ADVANCED-B", {
  ...advanced,
  members: [...advanced.members].reverse(),
});
run(
  "RECEIPTS-ADVANCED-A",
  vm.runInNewContext("(" + JSON.stringify(advanced) + ")"),
);
let rejected = 0;
for (const mutate of [
  (b) => {
    b.chat_id = uuid(9);
  },
  (b) => {
    b.members[1].user_id = f.aID;
  },
  (b) => {
    b.members[1].user_id = uuid(9);
  },
  (b) => {
    b.members[0].last_read_seq = 81;
  },
  (b) => {
    b.members[0].last_delivered_seq = 206;
  },
  (b) => {
    b.members[0].last_read_seq = -1;
  },
  (b) => {
    b.members[0].last_delivered_seq = 1.5;
  },
  (b) => {
    b.members[0].last_delivered_seq = 9007199254740992;
  },
  (b) => {
    b.members.pop();
  },
  (b) => {
    b.members.push({ ...b.members[0], user_id: uuid(4) });
  },
  (b) => {
    delete b.members[0].last_read_seq;
  },
  (b) => {
    b.members[0].last_read_seq = "42";
  },
  (b) => {
    b.members[0].private_last_read_seq = 205;
  },
  (b) => {
    b.members.forEach((m) => {
      m.last_read_seq = 0;
      m.last_delivered_seq = 0;
    });
  },
  (b) => {
    [b.members[0].user_id, b.members[1].user_id] = [
      b.members[1].user_id,
      b.members[0].user_id,
    ];
  },
]) {
  const body = structuredClone(advanced);
  mutate(body);
  assert.throws(() => run("RECEIPTS-ADVANCED-A", body));
  rejected++;
}
const leaked = snapshot([
  [205, 205],
  [0, 0],
]);
assert.throws(
  () => run("RECEIPTS-INITIAL-AFTER-REST-READ", leaked),
  /receipts expected/,
);
assert.throws(() =>
  run("RECEIPTS-ADVANCED-A", advanced, {
    ...headers,
    "cache-control": "public",
  }),
);
rejected += 2;
for (const name of ["limit", "after", "bad-value", "bad-key", "bare-percent"]) {
  assert.equal(
    cases.find((c) => c.id === "RECEIPTS-QUERY-" + name).status,
    422,
  );
  for (const auth of ["none", "invalid", "expired"])
    assert.equal(
      cases.find((c) => c.id === "RECEIPTS-AUTH-QUERY-" + name + "-" + auth)
        .status,
      401,
    );
}
assert.equal(cases.find((c) => c.id === "RECEIPTS-PRIVATE-B-READ").auth, "b");
assert.deepEqual(cases.find((c) => c.id === "RECEIPTS-PRIVATE-B-READ").body, {
  seq: 205,
});
console.log(
  `Receipts: 4 positive controls, ${rejected} rejected mutations; auth/query matrix checked`,
);
