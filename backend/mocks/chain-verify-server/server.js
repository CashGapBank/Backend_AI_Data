const http = require("node:http");

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST" || req.url !== "/chain/verify-claim") {
    res.writeHead(404, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: "not found" }));
  }
  const body = await readJson(req);
  const duplicate = String(body.source_id || "").includes("6666666");
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ verified: !duplicate, duplicate_financing: duplicate }));
});

const port = process.env.MOCK_CHAIN_PORT || 4010;
server.listen(port, () => console.log(`Mock chain verify server listening on http://127.0.0.1:${port}`));
