const http = require("node:http");

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>T24 tool trial</title></head>
<body><h1>T24 tool trial</h1><button type="button" id="check">Check API</button>
<p role="status">Not checked</p>
<script>
document.querySelector('#check').addEventListener('click', async () => {
  try {
    const response = await fetch('/health');
    const body = await response.json();
    document.querySelector('[role="status"]').textContent = body.status;
  } catch {
    document.querySelector('[role="status"]').textContent = 'unavailable';
  }
});
</script></body></html>`;

let accessToken = "";
let refreshToken = "";
const user = { id: "8f4f2c3a-9ad8-4c6a-8f90-3d24b54a21a0", username: "trial_user", created_at: "2026-11-16T12:00:00Z" };
function json(res, status, body, headers = {}) {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
function rotate(res) {
  accessToken = require("node:crypto").randomUUID();
  refreshToken = require("node:crypto").randomUUID();
  json(res, 200, { token_type: "Bearer", access_token: accessToken, expires_in: 900 },
    { "Set-Cookie": `refresh_token=${refreshToken}; Path=/auth; HttpOnly; SameSite=Lax` });
}
http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:3100");
  if (req.method === "POST" && url.pathname === "/auth/login") {
    let body = "";
    req.on("data", chunk => { body += chunk; });
    req.on("end", () => {
      try {
        const credentials = JSON.parse(body);
        if (credentials.username !== "trial_user" || credentials.password !== "fixture-password") throw new Error("bad credentials");
        rotate(res);
      } catch { json(res, 401, { code: "unauthorized", message: "Fixture credentials required" }); }
    });
    return;
  }
  if (req.method === "POST" && ["/auth/refresh", "/auth/logout"].includes(url.pathname)) {
    const cookie = (req.headers.cookie || "").split(";").map(c => c.trim());
    if (!refreshToken || !cookie.includes(`refresh_token=${refreshToken}`)) {
      json(res, 401, { code: "unauthorized", message: "Refresh cookie required" }); return;
    }
    if (url.pathname === "/auth/refresh") rotate(res);
    else {
      refreshToken = "";
      res.writeHead(204, { "Set-Cookie": "refresh_token=; Max-Age=0; Path=/auth; HttpOnly; SameSite=Lax" });
      res.end();
    }
    return;
  }
  if (req.method === "GET" && ["/me", "/contacts"].includes(url.pathname)) {
    if (!accessToken || req.headers.authorization !== `Bearer ${accessToken}`) {
      json(res, 401, { code: "unauthorized", message: "Bearer from login required" }); return;
    }
    if (url.pathname === "/contacts") json(res, 200, { contacts: [{ id: user.id, username: user.username }] });
    else json(res, 200, url.searchParams.has("invalid") ? { id: "bad-uuid", username: 42, extra: true } : user);
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(page);
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "not_found" }));
}).listen(3100, "127.0.0.1", () => {
  console.log("T24 fixture: http://127.0.0.1:3100");
});
