const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { verifyClaimWithChain, normalizeChainVerifyResponse } = require("../src/orchestration/cashClaims");
const { createMemoryStore } = require("../src/db/store.memory");
const { handleCredentialStatusChanged, handleCredentialRevoked } = require("../src/webhooks/handlers");

function startVerifier(handler) {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const response = handler(req, body);
    res.writeHead(response.status || 200, { "content-type": "application/json" });
    res.end(JSON.stringify(response.body));
  });
  return new Promise((resolve) => {
    server.listen(0, () => resolve(server));
  });
}

test("chain verify contract uses spec path, request shape, and response fields", async (t) => {
  let captured;
  const server = await startVerifier((req, body) => {
    captured = { method: req.method, url: req.url, body };
    return { body: { verified: true, duplicate_financing: false } };
  });
  t.after(() => server.close());

  const previous = process.env.CHAIN_VERIFY_URL;
  process.env.CHAIN_VERIFY_URL = `http://127.0.0.1:${server.address().port}/chain/verify-claim`;
  t.after(() => {
    if (previous === undefined) delete process.env.CHAIN_VERIFY_URL;
    else process.env.CHAIN_VERIFY_URL = previous;
  });

  const claim = {
    startup_id: "22222222-2222-4222-8222-222222222222",
    source_type: "invoice",
    source_id: "d1111111-1111-4111-8111-111111111111"
  };
  const result = await verifyClaimWithChain(claim);
  assert.deepEqual(result, { verified: true, duplicate_financing: false });
  assert.equal(captured.method, "POST");
  assert.equal(captured.url, "/chain/verify-claim");
  assert.deepEqual(captured.body, claim);
});

test("chain verify response rejects non-spec field types", () => {
  assert.throws(
    () => normalizeChainVerifyResponse({ verified: "yes", duplicate_financing: false }),
    /boolean verified and duplicate_financing/
  );
});

test("credential webhooks require spec section 4 body fields", async (t) => {
  const aiServiceResponses = {
    "/predict/seed-bridge": {
      seed_bridge_score: 70, funding_probability: 55, expected_closing: "2026-10-20",
      recommended_advance_capacity: 100000000, factors: { investor_trust: 80, diligence_stage: 90, runway: 40, closing_proximity: 70 }
    },
    "/predict/recovery-option": { recommended_option: "C", confidence: 0.9, class_probabilities: { A: 0, B: 0.1, C: 0.9, D: 0 } }
  };
  const aiServiceServer = await startVerifier((req) => ({
    body: aiServiceResponses[req.url] || {}
  }));
  t.after(() => aiServiceServer.close());
  const previousAiUrl = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${aiServiceServer.address().port}`;
  t.after(() => {
    if (previousAiUrl === undefined) delete process.env.AI_SERVICE_URL;
    else process.env.AI_SERVICE_URL = previousAiUrl;
  });

  const statusStore = createMemoryStore();
  const status = await handleCredentialStatusChanged(statusStore, {
    investment_commitment_id: "b1111111-1111-4111-8111-111111111111",
    new_status: "funds_wired",
    signed_by: "mock-chain",
    timestamp: "2026-09-15T10:00:00+09:00"
  });
  assert.equal(status.ok, true);

  await assert.rejects(
    () => handleCredentialStatusChanged(createMemoryStore(), {
      investment_commitment_id: "b1111111-1111-4111-8111-111111111111",
      new_status: "funds_wired"
    }),
    /signed_by, timestamp/
  );

  const revoked = await handleCredentialRevoked(createMemoryStore(), {
    investment_commitment_id: "b1111111-1111-4111-8111-111111111111",
    revoked_by: "mock-chain",
    reason: "credential revoked in mock sender",
    timestamp: "2026-09-15T10:00:00+09:00"
  });
  assert.equal(revoked.ok, true);

  await assert.rejects(
    () => handleCredentialRevoked(createMemoryStore(), {
      investment_commitment_id: "b1111111-1111-4111-8111-111111111111"
    }),
    /revoked_by, reason, timestamp/
  );
});
