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

http.createServer((req, res) => {
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
