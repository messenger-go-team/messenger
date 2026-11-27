const { randomBytes } = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { setTimeout: delay } = require("node:timers/promises");
const { parseArgs } = require("node:util");

const UUID = /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;
const NAMESPACE = /^[a-z0-9][a-z0-9_]{2,15}$/;
const SCHEMA_VERSION = 1;

function configuration() {
  const { values } = parseArgs({
    options: {
      "base-url": { type: "string" },
      "allow-origin": { type: "string" },
      namespace: { type: "string" },
      pairs: { type: "string" },
      "pace-ms": { type: "string", default: "0" },
    },
  });
  let url;
  try {
    url = new URL(values["base-url"]);
  } catch {
    throw new Error("Specify --base-url with the exact origin of the test environment");
  }
  const baseUrl = url.origin;
  if (![baseUrl, baseUrl + "/"].includes(values["base-url"])) {
    throw new Error("--base-url must be an origin without credentials, path, query or fragment");
  }
  const allowedOrigin = values["allow-origin"];
  const loopback = url.protocol === "http:" && url.hostname === "127.0.0.1";
  if ((!loopback && url.protocol !== "https:") ||
      (allowedOrigin === undefined ? !loopback : allowedOrigin !== baseUrl)) {
    throw new Error("Use HTTP on 127.0.0.1 or specify an approved HTTPS origin with --allow-origin");
  }

  const namespace = values.namespace;
  const pairs = Number(values.pairs);
  const paceMs = Number(values["pace-ms"]);
  if (!NAMESPACE.test(namespace ?? "")) {
    throw new Error("--namespace must contain 3 to 16 lowercase ASCII letters, digits or underscores and start with a letter or digit");
  }
  if (!/^\d+$/.test(values.pairs ?? "") || pairs < 1 || pairs > 1000) {
    throw new Error("--pairs must be an integer between 1 and 1000");
  }
  if (!/^\d+$/.test(values["pace-ms"]) || paceMs > 60000) {
    throw new Error("--pace-ms must be an integer between 0 and 60000");
  }
  return { baseUrl, namespace, pairs, paceMs };
}

function username(namespace, index, side) {
  return `k6_${namespace}_${String(index + 1).padStart(4, "0")}_${side}`;
}

async function loadCredentials(file, config) {
  let saved;
  try {
    saved = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error("Cannot read the private credentials file");
    }
    saved = {
      version: SCHEMA_VERSION,
      baseUrl: config.baseUrl,
      namespace: config.namespace,
      pairs: Array.from({ length: config.pairs }, (_, index) =>
        ["a", "b"].map((side) => ({
          username: username(config.namespace, index, side),
          password: randomBytes(24).toString("base64url"),
        })),
      ),
    };
    await fs.writeFile(file, JSON.stringify(saved, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
  }
  if (saved?.version !== SCHEMA_VERSION || saved.baseUrl !== config.baseUrl ||
      saved.namespace !== config.namespace || saved.pairs?.length !== config.pairs ||
      !Array.isArray(saved.pairs) || saved.pairs.some((pair, index) =>
        !Array.isArray(pair) || pair.length !== 2 || pair.some((account, side) =>
          account?.username !== username(config.namespace, index, side === 0 ? "a" : "b") ||
          typeof account.password !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(account.password),
        ),
      )) {
    throw new Error("Credentials do not match this origin, namespace or pair count");
  }
  return saved.pairs;
}

function client({ baseUrl, paceMs }) {
  let nextRequestAt = 0;
  return async function request(route, { body, token, statuses }) {
    const waitMs = nextRequestAt - Date.now();
    if (waitMs > 0) await delay(waitMs);
    nextRequestAt = Date.now() + paceMs;
    const headers = { Accept: "application/json" };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (token !== undefined) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetch(baseUrl + route, {
        method: body === undefined ? "GET" : "POST",
        body: body === undefined ? undefined : JSON.stringify(body),
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new Error(`${route}: connection, timeout or redirect error`);
    }
    if (!statuses.includes(response.status)) {
      await response.body?.cancel();
      throw new Error(`${route}: HTTP ${response.status}${response.status === 429 ? " (check the approved request rate before retrying)" : ""}`);
    }
    let data;
    try {
      data = await response.json();
    } catch {
      throw new Error(`${route}: expected a JSON response`);
    }
    return { status: response.status, data };
  };
}

async function register(request, account) {
  const { status, data } = await request("/auth/register", { body: account, statuses: [201, 409] });
  if (status === 409 && data?.code === "username_taken") return null;
  if (status !== 201 || !UUID.test(data?.id ?? "") || data?.username !== account.username) {
    throw new Error(`Unexpected registration response for ${account.username}`);
  }
  return data.id;
}

async function login(request, account, registeredId) {
  const startedAt = Date.now();
  const { data } = await request("/auth/login", { body: account, statuses: [200] });
  const { access_token: token, expires_in: ttl } = data ?? {};
  if (data?.token_type !== "Bearer" || typeof token !== "string" || token.length === 0 ||
      !Number.isSafeInteger(ttl) || ttl < 1) {
    throw new Error(`Invalid access-token response for ${account.username}`);
  }
  const { data: profile } = await request("/me", { token, statuses: [200] });
  if (!UUID.test(profile?.id ?? "") || profile?.username !== account.username ||
      (registeredId !== null && registeredId !== profile.id)) {
    throw new Error(`Wrong account identity for ${account.username}`);
  }
  return { id: profile.id, username: profile.username, accessToken: token, expiresAt: startedAt + ttl * 1000 };
}

async function personalChat(request, a, b) {
  const { status, data } = await request("/chats/personal", {
    token: a.accessToken,
    body: { user_id: b.id },
    statuses: [200, 201],
  });
  const ids = new Set(Array.isArray(data?.members) ? data.members.map((member) => member?.id) : []);
  if (!UUID.test(data?.id ?? "") || data?.type !== "personal" || a.id === b.id ||
      data?.members?.length !== 2 || ids.size !== 2 || !ids.has(a.id) || !ids.has(b.id) ||
      !Number.isSafeInteger(data.last_seq) || data.last_seq < 0) {
    throw new Error(`Invalid personal chat for ${a.username} and ${b.username}`);
  }
  return { created: status === 201, chatId: data.id, lastSeq: data.last_seq };
}

async function prepare(config, directory) {
  const accounts = await loadCredentials(path.join(directory, "credentials.json"), config);
  const runFile = path.join(directory, "run.json");
  const tempFile = path.join(directory, `run-${randomBytes(8).toString("hex")}.tmp`);
  await fs.rm(runFile, { force: true });
  const request = client(config);
  const pairs = [];
  const ids = [];
  let accountsCreated = 0;
  let chatsCreated = 0;
  let expiresAt = Infinity;

  // Register everyone before issuing access tokens to keep more of their TTL.
  for (const pair of accounts) {
    const registration = [];
    for (const account of pair) {
      const id = await register(request, account);
      if (id !== null) accountsCreated++;
      registration.push(id);
    }
    ids.push(registration);
  }
  for (let index = 0; index < accounts.length; index++) {
    const [accountA, accountB] = accounts[index];
    const [idA, idB] = ids[index];
    const a = await login(request, accountA, idA);
    const b = await login(request, accountB, idB);
    const { created, chatId, lastSeq } = await personalChat(request, a, b);
    if (created) chatsCreated++;
    pairs.push({ chatId, lastSeq, a, b });
    expiresAt = Math.min(expiresAt, a.expiresAt, b.expiresAt);
  }
  if (expiresAt <= Date.now()) {
    throw new Error("At least one access token expired during preparation");
  }
  const run = {
    version: SCHEMA_VERSION,
    baseUrl: config.baseUrl,
    namespace: config.namespace,
    generatedAt: new Date().toISOString(),
    expiresAt,
    pairs,
  };
  try {
    await fs.writeFile(tempFile, JSON.stringify(run, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(tempFile, runFile);
  } finally {
    await fs.rm(tempFile, { force: true });
  }

  console.log(`Accounts: ${accountsCreated} created, ${config.pairs * 2 - accountsCreated} reused`);
  console.log(`Chats: ${chatsCreated} created, ${config.pairs - chatsCreated} reused`);
  console.log(`Earliest token expiration: ${new Date(expiresAt).toISOString()}`);
  console.log(`Private k6 manifest: ${runFile}`);
}

async function main() {
  const config = configuration();
  const directory = path.join(__dirname, ".local", `k6_${config.namespace}`);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, "prepare.lock");
  try {
    await fs.mkdir(lock, { mode: 0o700 });
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("This namespace is locked by fixture preparation");
    throw error;
  }
  try {
    await prepare(config, directory);
  } finally {
    await fs.rmdir(lock);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
