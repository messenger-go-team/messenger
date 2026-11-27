const {
  refreshCookie,
  assertContext,
  assertLogoutCookie,
  assertRefreshJar,
} = require("./invariants.cjs");
const { assertReceiptSnapshot } = require("./receipts.cjs");
// Single source for collection order, contract binding and business assertions.
const cases = [];
function add(id, api, route, method, path, status, extra = {}) {
  cases.push({ id, api, route, method, path, status, auth: "a", ...extra });
}
const a = (id, route, method, path, status, extra) =>
  add(id, "auth", route, method, path, status, extra);
const h = (id, route, method, path, status, extra) =>
  add(id, "history", route, method, path, status, extra);
const unread = (body, id) => body.chats.find((c) => c.id === id).unread_count;
const cookie = (res, previous) => refreshCookie(res.headers, previous);
const credentials = { username: "{{aName}}", password: "{{password}}" };
const freshUser = { username: "qa49_registered", password: "{{password}}" };
a("AUTH-REGISTER", "/auth/register", "post", "/auth/register", 201, {
  auth: "none",
  body: freshUser,
  check: ({ b, e, v }) => {
    e(v.runner.iterationData.get("compatibility")).equal("csv-v7");
    e(b.username).equal("qa49_registered");
    e(b).not.have.property("password");
  },
});
a("AUTH-DUPLICATE", "/auth/register", "post", "/auth/register", 409, {
  auth: "none",
  body: { ...credentials, username: "QA49_A" },
});
for (const [name, body] of Object.entries({
  empty: { username: "", password: "12345678" },
  short: { username: "xy", password: "12345678" },
  long: { username: "x".repeat(33), password: "12345678" },
  unicode: { username: "кириллица", password: "12345678" },
  password: { username: "qa49_bad", password: "short" },
  missing: { username: "qa49_bad" },
  null: { username: null, password: "12345678" },
  extra: { ...credentials, unexpected: true },
}))
  a("AUTH-REGISTER-" + name, "/auth/register", "post", "/auth/register", 422, {
    auth: "none",
    body,
  });
a("AUTH-LOGIN", "/auth/login", "post", "/auth/login", 200, {
  auth: "none",
  body: { ...credentials, username: "QA49_a" },
  check: ({ b, e, v, res }) => {
    e(b.token_type).equal("Bearer");
    e(b.expires_in).equal(900);
    e(b).not.have.property("refresh_token");
    v.setVar("aToken", b.access_token);
    v.setVar("r1", cookie(res));
  },
});
a("AUTH-BAD-PASSWORD", "/auth/login", "post", "/auth/login", 401, {
  auth: "none",
  body: { ...credentials, password: "valid-but-wrong" },
  check: ({ b, v }) => v.setVar("loginError", b),
});
a("AUTH-MISSING-ACCOUNT", "/auth/login", "post", "/auth/login", 401, {
  auth: "none",
  body: { ...credentials, username: "qa49_absent" },
  check: ({ b, e, v }) => {
    e(b.code).equal(v.getVar("loginError").code);
    e(b.message).equal(v.getVar("loginError").message);
  },
});
for (const body of [
  {},
  { username: "x", password: "12345678" },
  { ...credentials, password: 7 },
  { ...credentials, extra: true },
])
  a(
    "AUTH-LOGIN-INVALID-" + cases.length,
    "/auth/login",
    "post",
    "/auth/login",
    422,
    { auth: "none", body },
  );
a("AUTH-ME-A", "/me", "get", "/me", 200, {
  check: ({ b, e, f }) => e(b.id).equal(f.aID),
});
a("AUTH-ME-B", "/me", "get", "/me", 200, {
  auth: "b",
  check: ({ b, e, f }) => e(b.id).equal(f.bID),
});
for (const auth of ["none", "invalid", "expired"])
  a("AUTH-ME-" + auth, "/me", "get", "/me", 401, { auth });
a("AUTH-REFRESH", "/auth/refresh", "post", "/auth/refresh", 200, {
  auth: "none",
  check: ({ b, e, v, res }) => {
    // Access JWTs issued in the same second may match; rotation applies to refresh.
    const next = cookie(res, v.getVar("r1"));
    v.setVar("aToken", b.access_token);
    v.setVar("r2", next);
  },
});
a("AUTH-OLD-REFRESH", "/auth/refresh", "post", "/auth/refresh", 401, {
  auth: "none",
  clearCookies: true,
  headers: { Cookie: "{{r1}}" },
});
a("AUTH-NEW-REFRESH", "/auth/refresh", "post", "/auth/refresh", 200, {
  auth: "none",
  headers: { Cookie: "{{r2}}" },
  check: ({ b, v, res }) => {
    v.setVar("lastRefresh", cookie(res, v.getVar("r2")));
    v.setVar("aToken", b.access_token);
  },
});
a("AUTH-LOGOUT", "/auth/logout", "post", "/auth/logout", 204, {
  auth: "none",
  captureRefreshJar: true,
  check: ({ v, res }) => {
    assertRefreshJar(v.getVar("AUTH-LOGOUT-refreshJar"), true);
    assertLogoutCookie(res.headers);
  },
});
a("AUTH-REFRESH-NO-COOKIE", "/auth/refresh", "post", "/auth/refresh", 401, {
  auth: "none",
  captureRefreshJar: true,
  check: ({ v }) =>
    assertRefreshJar(v.getVar("AUTH-REFRESH-NO-COOKIE-refreshJar"), false),
});
a("AUTH-LOGOUT-REPEAT", "/auth/logout", "post", "/auth/logout", 401, {
  auth: "none",
});
a(
  "AUTH-LOGOUT-REVOKED-REFRESH",
  "/auth/refresh",
  "post",
  "/auth/refresh",
  401,
  {
    auth: "none",
    clearCookies: true,
    headers: { Cookie: "{{lastRefresh}}" },
  },
);
a("AUTH-COOKIE-NOT-ACCESS", "/me", "get", "/me", 401, { auth: "none" });
for (const prefix of ["ALICE", "alice"])
  a(
    "SEARCH-" + prefix,
    "/users/search",
    "get",
    "/users/search?prefix=" + prefix,
    200,
    {
      check: ({ b, e, f }) => {
        e(b.users.map((u) => u.id)).include(f.aliceID);
        e(b.users.map((u) => u.id)).not.include(f.maliceID);
        e(b.users.find((u) => u.id === f.aliceID).username).equal("Alice_1");
      },
    },
  );
a(
  "SEARCH-LIMIT",
  "/users/search",
  "get",
  "/users/search?prefix=qa49_search_",
  200,
  {
    check: ({ b, e }) => {
      e(b.users.length).equal(20);
      for (const u of b.users)
        e(u.username.toLowerCase().startsWith("qa49_search_")).equal(true);
    },
  },
);
for (const prefix of ["A", "q".repeat(32)])
  a(
    "SEARCH-BOUNDARY-" + prefix.length,
    "/users/search",
    "get",
    "/users/search?prefix=" + prefix,
    200,
    { check: ({ b, e }) => e(b.users.length).greaterThan(0) },
  );
a(
  "SEARCH-EMPTY-RESULT",
  "/users/search",
  "get",
  "/users/search?prefix=definitely_absent_49",
  200,
  { check: ({ b, e }) => e(b.users).deep.equal([]) },
);
for (const query of [
  "",
  "?prefix=",
  "?prefix=" + "x".repeat(33),
  "?prefix=%40",
  "?prefix=%D1%8F",
])
  a(
    "SEARCH-INVALID-" + cases.length,
    "/users/search",
    "get",
    "/users/search" + query,
    422,
  );
a("SEARCH-401", "/users/search", "get", "/users/search?prefix=qa", 401, {
  auth: "none",
});
a("CONTACT-EMPTY", "/contacts", "get", "/contacts", 200, {
  check: ({ b, e }) => e(b.contacts).deep.equal([]),
});
for (const n of [1, 2])
  a(
    "CONTACT-PUT-" + n,
    "/contacts/{contact_id}",
    "put",
    "/contacts/{{bID}}",
    204,
  );
a("CONTACT-LIST-A", "/contacts", "get", "/contacts", 200, {
  check: ({ b, e, f }) => e(b.contacts.map((c) => c.id)).deep.equal([f.bID]),
});
a("CONTACT-LIST-B", "/contacts", "get", "/contacts", 200, {
  auth: "b",
  check: ({ b, e }) => e(b.contacts).deep.equal([]),
});
a("CONTACT-PUT-C", "/contacts/{contact_id}", "put", "/contacts/{{cID}}", 204);
a("CONTACT-SORT", "/contacts", "get", "/contacts", 200, {
  check: ({ b, e, f }) =>
    e(b.contacts.map((c) => c.id)).deep.equal([f.bID, f.cID]),
});
for (const n of [1, 2])
  a(
    "CONTACT-DELETE-" + n,
    "/contacts/{contact_id}",
    "delete",
    "/contacts/{{bID}}",
    204,
  );
a("CONTACT-PRESERVES-CHAT", "/contacts", "get", "/contacts", 200, {
  check: ({ b, e, f }) => e(b.contacts.map((c) => c.id)).deep.equal([f.cID]),
});
a(
  "CONTACT-SELF-PUT",
  "/contacts/{contact_id}",
  "put",
  "/contacts/{{aID}}",
  422,
);
a(
  "CONTACT-SELF-DELETE",
  "/contacts/{contact_id}",
  "delete",
  "/contacts/{{aID}}",
  204,
);
a(
  "CONTACT-MISSING-PUT",
  "/contacts/{contact_id}",
  "put",
  "/contacts/{{missingID}}",
  404,
);
a(
  "CONTACT-MISSING-DELETE",
  "/contacts/{contact_id}",
  "delete",
  "/contacts/{{missingID}}",
  204,
);
for (const method of ["put", "delete"]) {
  a(
    "CONTACT-UUID-" + method,
    "/contacts/{contact_id}",
    method,
    "/contacts/not-a-uuid",
    422,
  );
  a(
    "CONTACT-401-" + method,
    "/contacts/{contact_id}",
    method,
    "/contacts/{{bID}}",
    401,
    { auth: "none" },
  );
}
a("CONTACT-401-GET", "/contacts", "get", "/contacts", 401, { auth: "none" });
a(
  "INTERNAL-USER",
  "/internal/users/{user_id}",
  "get",
  "/internal/users/{{bID}}",
  200,
  {
    internal: true,
    auth: "service",
    check: ({ b, e, f }) => {
      e(b.id).equal(f.bID);
      e(Object.keys(b).sort()).deep.equal(["id", "username"]);
    },
  },
);
for (const auth of ["none", "invalid", "a"])
  a(
    "INTERNAL-401-" + auth,
    "/internal/users/{user_id}",
    "get",
    "/internal/users/{{bID}}",
    401,
    { internal: true, auth },
  );
for (const id of ["{{missingID}}", "bad-uuid"])
  a(
    "INTERNAL-404-" + cases.length,
    "/internal/users/{user_id}",
    "get",
    "/internal/users/" + id,
    404,
    { internal: true, auth: "service" },
  );
a(
  "INTERNAL-NOT-PUBLIC",
  "/internal/users/{user_id}",
  "get",
  "/internal/users/{{bID}}",
  404,
  { auth: "service", transport: true },
);
h("CHAT-EXISTING", "/chats/personal", "post", "/chats/personal", 200, {
  body: { user_id: "{{bID}}" },
  check: ({ b, e, f }) => e(b.id).equal(f.chatAB),
});
h("CHAT-NEW", "/chats/personal", "post", "/chats/personal", 201, {
  auth: "b",
  body: { user_id: "{{cID}}" },
  check: ({ b, v }) => v.setVar("newChatID", b.id),
});
h("CHAT-REVERSE", "/chats/personal", "post", "/chats/personal", 200, {
  auth: "c",
  body: { user_id: "{{bID}}" },
  check: ({ b, e, v }) => e(b.id).equal(v.getVar("newChatID")),
});
for (const [key, body, status] of [
  ["self", { user_id: "{{aID}}" }, 422],
  ["uuid", { user_id: "bad" }, 422],
  ["missing", { user_id: "{{missingID}}" }, 404],
  ["empty", {}, 422],
  ["extra", { user_id: "{{bID}}", owner_id: "{{cID}}" }, 422],
])
  h("CHAT-" + key, "/chats/personal", "post", "/chats/personal", status, {
    body,
  });
h("CHAT-401", "/chats/personal", "post", "/chats/personal", 401, {
  auth: "none",
  body: { user_id: "{{bID}}" },
});
h("CHATS-INITIAL-A", "/chats", "get", "/chats", 200, {
  check: ({ b, e, f }) => {
    e(unread(b, f.chatAB)).equal(204);
    e(unread(b, f.chatAC)).equal(2);
    e(b.chats.find((c) => c.id === f.chatAB).last_message.id).equal(f.lastID);
  },
});
h("CHATS-INITIAL-B", "/chats", "get", "/chats", 200, {
  auth: "b",
  check: ({ b, e, f }) => {
    e(unread(b, f.chatAB)).equal(1);
    e(b.chats.map((c) => c.id)).not.include(f.chatAC);
  },
});
h("CHATS-401", "/chats", "get", "/chats", 401, { auth: "none" });
const messages = "/chats/{chat_id}/messages",
  read = "/chats/{chat_id}/read",
  ctx = "/chats/{chat_id}/messages/{message_id}/context";
h("HISTORY-DEFAULT", messages, "get", "/chats/{{chatAB}}/messages", 200, {
  check: ({ b, e, f }) => {
    e(b.messages.length).equal(50);
    e(b.messages[0].seq).equal(156);
    e(b.messages.at(-1).id).equal(f.lastID);
  },
});
for (const [after, start, end, more] of [
  [0, 1, 100, true],
  [100, 101, 200, true],
  [200, 201, 205, false],
])
  h(
    "HISTORY-AFTER-" + after,
    messages,
    "get",
    `/chats/{{chatAB}}/messages?after_seq=${after === 0 ? 0 : "{{pageCursor}}"}&limit=100`,
    200,
    {
      check: ({ b, e, v }) => {
        e(b.messages.map((m) => m.seq)).deep.equal(
          Array.from({ length: end - start + 1 }, (_, i) => start + i),
        );
        e(b.next_after_seq).equal(end);
        e(b.has_more_after).equal(more);
        if (after !== 0) e(v.getVar("pageCursor")).equal(after);
        v.setVar("pageCursor", b.next_after_seq);
      },
    },
  );
h(
  "HISTORY-BEFORE",
  messages,
  "get",
  "/chats/{{chatAB}}/messages?before_seq=101&limit=100",
  200,
  {
    check: ({ b, e }) => {
      e(b.messages.length).equal(100);
      e(b.messages[0].seq).equal(1);
      e(b.messages.at(-1).seq).equal(100);
      e(b.has_more_before).equal(false);
    },
  },
);
h(
  "HISTORY-EMPTY",
  messages,
  "get",
  "/chats/{{chatAB}}/messages?after_seq=205",
  200,
  {
    check: ({ b, e }) => {
      e(b.messages).deep.equal([]);
      e(b.next_after_seq).equal(null);
      e(b.next_before_seq).equal(null);
      e(b.has_more_after).equal(false);
    },
  },
);
for (const q of [
  "limit=0",
  "limit=101",
  "after_seq=-1",
  "before_seq=0",
  "after_seq=1&before_seq=2",
  "after_seq=1.5",
  "after_seq=9007199254740992",
])
  h(
    "HISTORY-422-" + cases.length,
    messages,
    "get",
    "/chats/{{chatAB}}/messages?" + q,
    422,
  );
h("HISTORY-403", messages, "get", "/chats/{{chatAB}}/messages", 403, {
  auth: "c",
});
h("HISTORY-404", messages, "get", "/chats/{{missingID}}/messages", 404);
h("HISTORY-401", messages, "get", "/chats/{{chatAB}}/messages", 401, {
  auth: "none",
});
h("UNREAD-GET-UNCHANGED", "/chats", "get", "/chats", 200, {
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(204),
});
h("READ-ZERO", read, "post", "/chats/{{chatAB}}/read", 204, {
  body: { seq: 0 },
});
h("READ-TWO", read, "post", "/chats/{{chatAB}}/read", 204, {
  body: { seq: 2 },
});
h("UNREAD-PARTIAL", "/chats", "get", "/chats", 200, {
  check: ({ b, e, f }) => {
    e(unread(b, f.chatAB)).equal(202);
    e(unread(b, f.chatAC)).equal(2);
  },
});
for (const seq of [2, 1, 0])
  h("READ-IDEMPOTENT-" + seq, read, "post", "/chats/{{chatAB}}/read", 204, {
    body: { seq },
  });
h("UNREAD-NO-REGRESSION", "/chats", "get", "/chats", 200, {
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(202),
});
for (const body of [
  { seq: -1 },
  { seq: 206 },
  { seq: 1.5 },
  { seq: "2" },
  {},
  { seq: 9007199254740992 },
  { seq: 2, extra: true },
])
  h("READ-422-" + cases.length, read, "post", "/chats/{{chatAB}}/read", 422, {
    body,
  });
h("READ-403", read, "post", "/chats/{{chatAB}}/read", 403, {
  auth: "c",
  body: { seq: 1 },
});
h("READ-404", read, "post", "/chats/{{missingID}}/read", 404, {
  body: { seq: 0 },
});
h("READ-401", read, "post", "/chats/{{chatAB}}/read", 401, {
  auth: "none",
  body: { seq: 0 },
});
h("UNREAD-ERROR-UNCHANGED", "/chats", "get", "/chats", 200, {
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(202),
});
h("READ-LAST", read, "post", "/chats/{{chatAB}}/read", 204, {
  body: { seq: 205 },
});
h("UNREAD-A-DONE", "/chats", "get", "/chats", 200, {
  check: ({ b, e, f }) => {
    e(unread(b, f.chatAB)).equal(0);
    e(unread(b, f.chatAC)).equal(2);
  },
});
h("UNREAD-B-ISOLATED", "/chats", "get", "/chats", 200, {
  auth: "b",
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(1),
});
for (const [name, key, seq] of [
  ["MIDDLE", "targetID", 150],
  ["FIRST", "firstID", 1],
  ["LAST", "lastID", 205],
])
  for (const limit of [1, 3, 100])
    h(
      name === "MIDDLE"
        ? "CONTEXT-" + limit
        : "CONTEXT-EDGE-" + name + "-" + limit,
      ctx,
      "get",
      `/chats/{{chatAB}}/messages/{{${key}}}/context?limit=${limit}`,
      200,
      {
        check: ({ b, f }) =>
          assertContext(b, {
            targetID: f[key],
            chatID: f.chatAB,
            targetSeq: seq,
            limit,
          }),
      },
    );
h(
  "CONTEXT-DEFAULT",
  ctx,
  "get",
  "/chats/{{chatAB}}/messages/{{targetID}}/context",
  200,
  {
    check: ({ b, f }) =>
      assertContext(b, {
        targetID: f.targetID,
        chatID: f.chatAB,
        targetSeq: 150,
        limit: 50,
      }),
  },
);
for (const q of ["limit=0", "limit=101", "after_seq=0", "before_seq=3"])
  h(
    "CONTEXT-422-" + cases.length,
    ctx,
    "get",
    "/chats/{{chatAB}}/messages/{{targetID}}/context?" + q,
    422,
  );
h(
  "CONTEXT-401",
  ctx,
  "get",
  "/chats/{{chatAB}}/messages/{{targetID}}/context",
  401,
  { auth: "none" },
);
h(
  "CONTEXT-FOREIGN",
  ctx,
  "get",
  "/chats/{{chatAB}}/messages/{{targetID}}/context",
  404,
  { auth: "c" },
);
h(
  "CONTEXT-MISMATCH",
  ctx,
  "get",
  "/chats/{{chatAC}}/messages/{{targetID}}/context",
  404,
);
h(
  "CONTEXT-MISSING",
  ctx,
  "get",
  "/chats/{{chatAB}}/messages/{{missingID}}/context",
  404,
);
h("CONTEXT-UUID", ctx, "get", "/chats/{{chatAB}}/messages/bad/context", 422);
const save = {
  chat_id: "{{chatAB}}",
  message_id: "{{targetID}}",
  due_at: null,
};
const future = "2099-01-01T00:00:00Z",
  past = "2020-01-01T00:00:00Z";
h("LATER-EMPTY", "/later", "get", "/later", 200, {
  check: ({ b, e }) => e(b.entries).deep.equal([]),
});
h("LATER-SAVE", "/later", "post", "/later", 201, {
  body: save,
  check: ({ b, e, v }) => {
    e(b.entry.due_at).equal(null);
    e(b.entry.status).equal("unscheduled");
    v.setVar("laterID", b.entry.id);
    v.setVar("laterCreated", b.entry.created_at);
  },
});
h("LATER-UPSERT", "/later", "post", "/later", 200, {
  body: { ...save, due_at: future },
  check: ({ b, e, v }) => {
    e(b.entry.id).equal(v.getVar("laterID"));
    e(b.entry.created_at).equal(v.getVar("laterCreated"));
    e(b.entry.status).equal("scheduled");
  },
});
h("LATER-PATCH", "/later/{later_id}", "patch", "/later/{{laterID}}", 200, {
  body: { due_at: past },
  check: ({ b, e, v }) => {
    e(b.entry.id).equal(v.getVar("laterID"));
    e(b.entry.status).equal("due");
  },
});
h("LATER-LIST", "/later", "get", "/later", 200, {
  check: ({ b, e, v }) => {
    e(b.entries.length).equal(1);
    e(b.entries[0].id).equal(v.getVar("laterID"));
    e(b.entries[0].status).equal("due");
  },
});
h("LATER-B-PRIVATE", "/later", "get", "/later", 200, {
  auth: "b",
  check: ({ b, e }) => e(b.entries).deep.equal([]),
});
for (const [method, route, path, body] of [
  ["patch", "/later/{later_id}", "/later/{{laterID}}", { due_at: null }],
  ["post", "/later/{later_id}/done", "/later/{{laterID}}/done", undefined],
])
  h("LATER-FOREIGN-" + method, route, method, path, 404, { auth: "b", body });
h("LATER-B-SAVE", "/later", "post", "/later", 201, {
  auth: "b",
  body: save,
  check: ({ b, e, v }) => {
    e(b.entry.id).not.equal(v.getVar("laterID"));
    v.setVar("bLaterID", b.entry.id);
  },
});
h("LATER-A-ISOLATED", "/later", "get", "/later", 200, {
  check: ({ b, e, v }) =>
    e(b.entries.map((x) => x.id)).deep.equal([v.getVar("laterID")]),
});
for (const n of [1, 2])
  h(
    "LATER-DONE-" + n,
    "/later/{later_id}/done",
    "post",
    "/later/{{laterID}}/done",
    204,
  );
h("LATER-A-EMPTY", "/later", "get", "/later", 200, {
  check: ({ b, e }) => e(b.entries).deep.equal([]),
});
h("LATER-RECREATE", "/later", "post", "/later", 201, {
  body: save,
  check: ({ b, e, v }) => {
    e(b.entry.id).not.equal(v.getVar("laterID"));
    v.setVar("previousLaterID", v.getVar("laterID"));
    v.setVar("laterID", b.entry.id);
  },
});
h(
  "LATER-OLD-DONE",
  "/later/{later_id}/done",
  "post",
  "/later/{{previousLaterID}}/done",
  204,
);
h("LATER-NEW-ACTIVE", "/later", "get", "/later", 200, {
  check: ({ b, e, v }) =>
    e(b.entries.map((x) => x.id)).deep.equal([v.getVar("laterID")]),
});
const operations = [
  ["post", "/later", "/later", save],
  ["get", "/later", "/later", undefined],
  ["patch", "/later/{later_id}", "/later/{{laterID}}", { due_at: null }],
  ["post", "/later/{later_id}/done", "/later/{{laterID}}/done", undefined],
];
const invalidQueries = ["limit=1", "unexpected=1", "due_at=%zz", "%zz=1", "%"];
for (const [method, route, path, originalBody] of operations) {
  const body =
    method === "get"
      ? undefined
      : originalBody
        ? { ...originalBody, due_at: future }
        : undefined;
  h("LATER-401-" + method + route, route, method, path, 401, {
    auth: "none",
    body,
    unchangedLater: true,
  });
  for (const query of invalidQueries) {
    h("LATER-QUERY-" + cases.length, route, method, path + "?" + query, 422, {
      body,
      unchangedLater: true,
    });
    for (const auth of ["none", "invalid", "expired"])
      h(
        "LATER-AUTH-QUERY-" + cases.length,
        route,
        method,
        path + "?" + query,
        401,
        { auth, body, unchangedLater: true },
      );
  }
}
// A fresh message exercises rejected POST creation, separately from active-entry upsert.
for (const query of invalidQueries)
  h(
    "LATER-CREATE-QUERY-" + cases.length,
    "/later",
    "post",
    "/later?" + query,
    422,
    {
      body: {
        chat_id: "{{chatAB}}",
        message_id: "{{firstID}}",
        due_at: future,
      },
      unchangedLater: true,
    },
  );
for (const value of [
  "2026-02-30T12:00:00Z",
  "2026-01-01T12:00:00+00:00",
  "2026-01-01T12:00:00.1234567Z",
  "0000-01-01T00:00:00Z",
  123,
  "",
])
  h(
    "LATER-TIME-" + cases.length,
    "/later/{later_id}",
    "patch",
    "/later/{{laterID}}",
    422,
    { body: { due_at: value } },
  );
h("LATER-MISSING-DUE", "/later", "post", "/later", 422, {
  body: { chat_id: "{{chatAB}}", message_id: "{{targetID}}" },
});
h("LATER-EXTRA", "/later/{later_id}", "patch", "/later/{{laterID}}", 422, {
  body: { due_at: null, owner_id: "{{bID}}" },
});
h("LATER-MISMATCH", "/later", "post", "/later", 404, {
  body: { ...save, chat_id: "{{chatAC}}" },
});
h("LATER-C-DENIED", "/later", "post", "/later", 404, { auth: "c", body: save });
h(
  "LATER-MISSING-ID",
  "/later/{later_id}",
  "patch",
  "/later/{{missingID}}",
  404,
  { body: { due_at: null } },
);
h("LATER-UUID", "/later/{later_id}", "patch", "/later/bad-uuid", 422, {
  body: { due_at: null },
});
h("LATER-ACCESS-SAVE", "/later", "post", "/later", 201, {
  body: {
    chat_id: "{{chatAC}}",
    message_id: "{{accessTargetID}}",
    due_at: null,
  },
  check: ({ b, v }) => v.setVar("accessLaterID", b.entry.id),
});
h("LATER-ACCESS-LOST", "/later", "get", "/later", 200, {
  control: "revoke",
  check: ({ b, e, v }) =>
    e(b.entries.map((x) => x.id)).not.include(v.getVar("accessLaterID")),
});
h(
  "LATER-ACCESS-PATCH",
  "/later/{later_id}",
  "patch",
  "/later/{{accessLaterID}}",
  404,
  { body: { due_at: null } },
);
h(
  "CONTEXT-ACCESS-LOST",
  ctx,
  "get",
  "/chats/{{chatAC}}/messages/{{accessTargetID}}/context",
  404,
);
h("LATER-ACCESS-RESTORED", "/later", "get", "/later", 200, {
  control: "restore",
  check: ({ b, e, v }) =>
    e(b.entries.map((x) => x.id)).include(v.getVar("accessLaterID")),
});
h("LATER-DELETED-SOURCE", "/later", "get", "/later", 200, {
  control: "delete-source",
  check: ({ b, e, v }) =>
    e(b.entries.map((x) => x.id)).not.include(v.getVar("laterID")),
});
h(
  "LATER-DELETED-PATCH",
  "/later/{later_id}",
  "patch",
  "/later/{{laterID}}",
  404,
  { body: { due_at: null } },
);
h(
  "CONTEXT-DELETED-SOURCE",
  ctx,
  "get",
  "/chats/{{chatAB}}/messages/{{targetID}}/context",
  404,
);
h("LATER-DELETED-CHAT", "/later", "get", "/later", 200, {
  control: "delete-chat",
  check: ({ b, e }) => e(b.entries).deep.equal([]),
});
h(
  "LATER-DELETED-DONE",
  "/later/{later_id}/done",
  "post",
  "/later/{{accessLaterID}}/done",
  404,
);
h("LATER-FAULT-SEED", "/later", "post", "/later", 201, {
  body: { chat_id: "{{chatAB}}", message_id: "{{lastID}}", due_at: null },
  check: ({ b, v }) => v.setVar("faultLaterID", b.entry.id),
});
h("LATER-503-LIST", "/later", "get", "/later", 503, {
  control: "storage-down",
});
for (const [method, route, path, body] of [
  [
    "post",
    "/later",
    "/later",
    { chat_id: "{{chatAB}}", message_id: "{{lastID}}", due_at: future },
  ],
  ["patch", "/later/{later_id}", "/later/{{faultLaterID}}", { due_at: future }],
  ["post", "/later/{later_id}/done", "/later/{{faultLaterID}}/done", undefined],
])
  h("LATER-503-" + method + route, route, method, path, 503, {
    body,
    check: ({ b, e }) => e(b.code).equal("service_unavailable"),
  });
for (const [method, route, path, body] of [
  ["post", "/chats/personal", "/chats/personal", { user_id: "{{bID}}" }],
  ["get", ctx, "/chats/{{chatAB}}/messages/{{lastID}}/context", undefined],
  ["get", "/chats", "/chats", undefined],
  ["get", messages, "/chats/{{chatAB}}/messages", undefined],
  ["post", read, "/chats/{{chatAB}}/read", { seq: 205 }],
])
  h("HISTORY-503-" + method + route, route, method, path, 503, {
    body,
    check: ({ b, e }) => e(b.code).equal("service_unavailable"),
  });
h("LATER-RECOVERED", "/later", "get", "/later", 200, {
  control: "storage-up",
  check: ({ b, e, v }) => {
    e(b.entries.map((x) => x.id)).deep.equal([v.getVar("faultLaterID")]);
    e(b.entries[0].due_at).equal(null);
  },
});
h("UNREAD-AFTER-PRIVATE-WRITES", "/chats", "get", "/chats", 200, {
  auth: "b",
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(1),
});
const receipts = "/chats/{chat_id}/receipts";
const receiptsAB = "/chats/{{chatAB}}/receipts";
const receiptsCheck =
  (expected, lastSeq) =>
  ({ b, f, res }) =>
    assertReceiptSnapshot(b, f, expected, res.headers, lastSeq);
const initialReceipts = [
  [0, 0],
  [0, 0],
];
const advancedReceipts = [
  [80, 42],
  [7, 3],
];
const checkInitialReceipts = receiptsCheck(initialReceipts);
h("RECEIPTS-INITIAL-AFTER-REST-READ", receipts, "get", receiptsAB, 200, {
  check: checkInitialReceipts,
});
h("RECEIPTS-401", receipts, "get", receiptsAB + "?unexpected=1", 401, {
  auth: "none",
});
h("RECEIPTS-403", receipts, "get", receiptsAB, 403, { auth: "c" });
h("RECEIPTS-404", receipts, "get", "/chats/{{missingID}}/receipts", 404);
h("RECEIPTS-422-QUERY", receipts, "get", receiptsAB + "?unexpected=1", 422);
h("RECEIPTS-422-UUID", receipts, "get", "/chats/bad-uuid/receipts", 422);
h("RECEIPTS-503", receipts, "get", receiptsAB, 503, {
  control: "storage-down",
  check: ({ b, e }) => e(b.code).equal("service_unavailable"),
});
h("RECEIPTS-RECOVERED", receipts, "get", receiptsAB, 200, {
  auth: "b",
  control: "storage-up",
  check: checkInitialReceipts,
});
// T137: explicit private-read isolation, nonzero snapshots and auth precedence.
h("RECEIPTS-PRIVATE-B-BEFORE", "/chats", "get", "/chats", 200, {
  auth: "b",
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(1),
});
h("RECEIPTS-PRIVATE-B-READ", read, "post", "/chats/{{chatAB}}/read", 204, {
  auth: "b",
  body: { seq: 205 },
});
h("RECEIPTS-PRIVATE-B-AFTER", "/chats", "get", "/chats", 200, {
  auth: "b",
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(0),
});
for (const auth of ["a", "b"])
  h("RECEIPTS-ZERO-BOTH-" + auth, receipts, "get", receiptsAB, 200, {
    auth,
    check: checkInitialReceipts,
  });
// Seed public state through real History RPC, not SQL or a fake REST response.
// This proves REST projection only; it does not test Chat WS fanout.
h("RECEIPTS-ADVANCED-A", receipts, "get", receiptsAB, 200, {
  control: "advance-receipts",
  check: receiptsCheck(advancedReceipts),
});
h("RECEIPTS-ADVANCED-B", receipts, "get", receiptsAB, 200, {
  auth: "b",
  check: receiptsCheck(advancedReceipts),
});
for (const [auth, seq] of [
  ["a", 1],
  ["b", 205],
  ["b", 0],
]) {
  h(
    "RECEIPTS-PRIVATE-REPEAT-" + auth + seq,
    read,
    "post",
    "/chats/{{chatAB}}/read",
    204,
    {
      auth,
      body: { seq },
    },
  );
  h("RECEIPTS-UNCHANGED-" + auth + seq, receipts, "get", receiptsAB, 200, {
    auth,
    check: receiptsCheck(advancedReceipts),
  });
}
for (const auth of ["a", "b"])
  h("RECEIPTS-PRIVATE-UNREAD-" + auth, "/chats", "get", "/chats", 200, {
    auth,
    check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(0),
  });
for (const [name, query] of [
  ["limit", "limit=1"],
  ["after", "after_seq=0"],
  ["bad-value", "unexpected=%zz"],
  ["bad-key", "%zz=1"],
  ["bare-percent", "%"],
]) {
  h("RECEIPTS-QUERY-" + name, receipts, "get", receiptsAB + "?" + query, 422, {
    check: ({ b, e }) => e(b.code).equal("validation_error"),
  });
  for (const auth of ["none", "invalid", "expired"])
    h(
      "RECEIPTS-AUTH-QUERY-" + name + "-" + auth,
      receipts,
      "get",
      receiptsAB + "?" + query,
      401,
      { auth },
    );
}
for (const auth of ["none", "invalid", "expired"])
  h(
    "RECEIPTS-AUTH-BAD-PATH-" + auth,
    receipts,
    "get",
    "/chats/bad-uuid/receipts?%",
    401,
    { auth },
  );
h(
  "RECEIPTS-ZERO-UUID",
  receipts,
  "get",
  "/chats/00000000-0000-0000-0000-000000000000/receipts",
  422,
);
h("RECEIPTS-GROUP-MEMBER", receipts, "get", receiptsAB, 422, {
  control: "receipts-group",
});
h("RECEIPTS-GROUP-OUTSIDER", receipts, "get", receiptsAB, 403, { auth: "c" });
h("RECEIPTS-GROUP-RESTORED", receipts, "get", receiptsAB, 200, {
  control: "receipts-personal",
  check: receiptsCheck(advancedReceipts),
});
h("RECEIPTS-ADVANCED-503", receipts, "get", receiptsAB, 503, {
  control: "storage-down",
  check: ({ b, e }) => e(b.code).equal("service_unavailable"),
});
h("RECEIPTS-ADVANCED-RECOVERED", receipts, "get", receiptsAB, 200, {
  control: "storage-up",
  check: receiptsCheck(advancedReceipts),
});
// Append after the other cases that depend on the original last_seq=205.
h("RECEIPTS-PRIVATE-ADVANCE-B-BEFORE", "/chats", "get", "/chats", 200, {
  auth: "b",
  control: "append-private-read-message",
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(1),
});
h("RECEIPTS-PRIVATE-ADVANCE-B-READ", read, "post", "/chats/{{chatAB}}/read", 204, {
  auth: "b",
  body: { seq: 206 },
});
h("RECEIPTS-PRIVATE-ADVANCE-B-AFTER", "/chats", "get", "/chats", 200, {
  auth: "b",
  check: ({ b, e, f }) => e(unread(b, f.chatAB)).equal(0),
});
for (const auth of ["a", "b"])
  h("RECEIPTS-AFTER-PRIVATE-ADVANCE-" + auth, receipts, "get", receiptsAB, 200, {
    auth,
    check: receiptsCheck(advancedReceipts, 206),
  });
module.exports = { cases };
