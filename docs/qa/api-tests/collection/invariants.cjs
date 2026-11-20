const assert = require("node:assert/strict");
// Bruno developer-mode module caching bridges objects from separate JS realms.
// Compare JSON values, never the realm-specific Array/Object prototypes.
const jsonValue = (value) => JSON.parse(JSON.stringify(value));

function refreshCookie(headers, previous) {
  const raw = headers["set-cookie"];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(
    (x) => typeof x === "string" && /^refresh_token=/.test(x),
  );
  assert.equal(cookies.length, 1, "one refresh Set-Cookie required");
  const [cookie, ...attributes] = cookies[0].split(";").map((x) => x.trim());
  assert.match(cookie, /^refresh_token=[^;\s]+$/, "nonempty refresh cookie");
  const flags = new Map(
    attributes.map((x) => {
      const i = x.indexOf("=");
      return i < 0
        ? [x.toLowerCase(), true]
        : [x.slice(0, i).toLowerCase(), x.slice(i + 1)];
    }),
  );
  assert.equal(flags.get("httponly"), true, "refresh HttpOnly");
  assert.equal(flags.get("secure"), true, "refresh Secure");
  assert.equal(
    String(flags.get("samesite")).toLowerCase(),
    "lax",
    "refresh SameSite=Lax",
  );
  assert.equal(flags.get("path"), "/auth", "refresh Path=/auth");
  if (previous !== undefined)
    assert.notEqual(cookie, previous, "refresh cookie must rotate");
  return cookie;
}

function assertLogoutCookie(headers) {
  const raw = headers["set-cookie"];
  const cookies = (Array.isArray(raw) ? raw : [raw]).filter(
    (x) => typeof x === "string" && /^refresh_token=/.test(x),
  );
  assert.equal(cookies.length, 1, "logout must expire refresh_token");
  const attributes = new Map(
    cookies[0]
      .split(";")
      .slice(1)
      .map((x) => {
        const [name, ...value] = x.trim().split("=");
        return [name.toLowerCase(), value.join("=")];
      }),
  );
  assert.equal(attributes.get("path"), "/auth", "logout refresh Path=/auth");
  assert.equal(attributes.get("max-age"), "0", "logout refresh Max-Age=0");
}

async function readRefreshJar(bru, baseUrl) {
  const cookies = await bru.cookies.jar().getCookies(baseUrl + "/auth/refresh");
  // Keep token values out of snapshots/assertion failures.
  return cookies
    .filter((c) => c.key === "refresh_token")
    .map((c) => ({ path: c.path }));
}

function assertRefreshJar(cookies, present) {
  assert.equal(
    cookies.length,
    present ? 1 : 0,
    present
      ? "refresh cookie must exist before logout"
      : "refresh cookie must be absent after logout before manual clear",
  );
  if (present) assert.equal(cookies[0].path, "/auth", "jar refresh Path=/auth");
}

function assertContext(
  body,
  { targetID, chatID, targetSeq, limit, firstSeq = 1, lastSeq = 205 },
) {
  const first = Math.max(firstSeq, targetSeq - Math.floor((limit - 1) / 2));
  const last = Math.min(
    lastSeq,
    targetSeq + (limit - 1 - Math.floor((limit - 1) / 2)),
  );
  assert.equal(body.target_message_id, targetID, "context target ID");
  assert.deepEqual(
    jsonValue(body.messages.map((m) => m.seq)),
    Array.from({ length: last - first + 1 }, (_, i) => first + i),
    "context exact seq window",
  );
  assert.equal(
    body.messages.filter((m) => m.id === targetID && m.seq === targetSeq)
      .length,
    1,
    "context target once",
  );
  assert.equal(
    new Set(body.messages.map((m) => m.id)).size,
    body.messages.length,
    "context unique IDs",
  );
  assert.ok(
    body.messages.every((m) => m.chat_id === chatID),
    "context chat ID",
  );
  assert.equal(body.next_before_seq, first, "context before cursor");
  assert.equal(body.next_after_seq, last, "context after cursor");
  assert.equal(
    body.has_more_before,
    first > firstSeq,
    "context has_more_before",
  );
  assert.equal(body.has_more_after, last < lastSeq, "context has_more_after");
}

function assertUnchangedLater(before, after) {
  assert.deepEqual(
    jsonValue(after),
    jsonValue(before),
    "Later state changed after rejected request (IDs, due_at, state, updated_at)",
  );
}
module.exports = {
  refreshCookie,
  assertLogoutCookie,
  readRefreshJar,
  assertRefreshJar,
  assertContext,
  assertUnchangedLater,
};
