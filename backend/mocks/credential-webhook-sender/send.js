async function post(path, body) {
  const baseUrl = process.env.API_BASE_URL || "http://127.0.0.1:4000";
  const res = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await res.json();
  console.log(JSON.stringify({ status: res.status, path, payload }, null, 2));
}

const event = process.argv[2] || "status";
if (event === "revoked") {
  post("/api/webhooks/credential-revoked", {
    investment_commitment_id: process.argv[3] || "b1111111-1111-4111-8111-111111111111",
    revoked_by: "mock-chain",
    reason: "credential revoked in mock sender",
    timestamp: new Date().toISOString()
  });
} else if (event === "chain-status") {
  post("/api/webhooks/chain-status-changed", {
    cash_claim_id: process.argv[3] || "e1111111-1111-4111-8111-111111111111",
    new_chain_status: process.argv[4] || "FINANCED",
    timestamp: new Date().toISOString()
  });
} else {
  post("/api/webhooks/credential-status-changed", {
    investment_commitment_id: process.argv[3] || "b1111111-1111-4111-8111-111111111111",
    new_status: process.argv[4] || "funds_wired",
    signed_by: "mock-chain",
    timestamp: new Date().toISOString()
  });
}
