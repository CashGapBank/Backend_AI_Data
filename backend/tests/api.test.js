const http = require("node:http");
const test = require("node:test");
const { before, after } = require("node:test");
const assert = require("node:assert/strict");
const { start } = require("../src/api/server");

// ai-service is a separate Python process in real deployments (see
// engines/aiServiceClient.js and cash-gap-bank-spec.md section 7). These
// wiring tests mock it with a small HTTP stub so `npm test` stays fast and
// dependency-free; tests/integration/ai-service.integration.js exercises the
// real trained models end-to-end instead.
function fakeRecoveryOption(body) {
  // Test-only mirror of the spec section 3 waterfall, used purely so the
  // mocked /predict/recovery-option response is internally consistent with
  // whatever features the backend actually sent.
  const { outstanding_bridge, verified_receivables, runway_months, past_investment_count } = body;
  let recommended_option;
  if (verified_receivables >= outstanding_bridge * 1.5) recommended_option = "A";
  else if (runway_months >= 4) recommended_option = "B";
  else if (runway_months < 2 && past_investment_count >= 2) recommended_option = "C";
  else recommended_option = "D";
  return {
    recommended_option,
    confidence: 0.9,
    class_probabilities: { A: 0, B: 0, C: 0, D: 0, [recommended_option]: 0.9 }
  };
}

const FAKE_RESPONSES = {
  "/predict/document-intelligence": {
    amount: 600000000,
    counterparty: "Han River Ventures",
    payment_date: "2026-10-05",
    expected_closing: "2026-10-05",
    conditions_precedent: ["final board minutes"],
    termination_clause: "revoked if board approval fails",
    payment_term: "funds wired on closing"
  },
  "/predict/time-to-cash": { payment_probability: 82, expected_settlement_days: 25, p30: 40, p60: 70, p90: 90 },
  "/predict/network-credit": { network_credit_score: 85, counterparty_risk: "low" },
  "/predict/seed-bridge": {
    seed_bridge_score: 81,
    funding_probability: 70,
    expected_closing: "2026-10-05",
    recommended_advance_capacity: 200000000,
    factors: { investor_trust: 92, diligence_stage: 90, runway: 42, closing_proximity: 90 }
  }
};

function startFakeAiService() {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    const response = req.url === "/predict/recovery-option" ? fakeRecoveryOption(body) : FAKE_RESPONSES[req.url];
    if (!response) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: `unmapped path ${req.url}` }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  return new Promise((resolve) => server.listen(0, () => resolve(server)));
}

let aiService;
let previousAiServiceUrl;

before(async () => {
  aiService = await startFakeAiService();
  previousAiServiceUrl = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${aiService.address().port}`;
});

after(() => {
  aiService.close();
  if (previousAiServiceUrl === undefined) delete process.env.AI_SERVICE_URL;
  else process.env.AI_SERVICE_URL = previousAiServiceUrl;
});

test("api endpoints expose ai-service-backed scores and the cash-claim pipeline", async (t) => {
  const server = start(0);
  t.after(() => server.close());
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const health = await fetch(`${base}/health`);
  assert.equal(health.status, 200);

  const score = await fetch(`${base}/api/scores/seed-bridge/b1111111-1111-4111-8111-111111111111`).then((r) => r.json());
  assert.equal(score.seed_bridge_score, 81);

  const claim = await fetch(`${base}/api/cash-claims`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startup_id: "22222222-2222-4222-8222-222222222222",
      source_type: "invoice",
      source_id: "d1111111-1111-4111-8111-111111111111",
      document_text: "Invoice amount KRW 180,000,000 counterparty: Samsung SDS AI Transformation PoC Team payment term: net 30"
    })
  }).then((r) => r.json());

  assert.equal(claim.verified_on_chain, true);
  assert.equal(claim.ai_scores.network_credit_score, 85);
  assert.equal(claim.ai_scores.counterparty_risk, "low");
  assert.ok(claim.safe_advance_capacity > 0);
});

test("api exposes document, graph, time-to-cash, advance, recovery, and webhook flows", async (t) => {
  const local = start(0);
  t.after(() => local.close());
  await new Promise((resolve) => local.once("listening", resolve));
  const { port } = local.address();
  const base = `http://127.0.0.1:${port}`;

  const extract = await fetch(`${base}/api/document-intelligence/extract`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      document_type: "term_sheet",
      document_text: "Committed amount KRW 600,000,000 investor: Han River Ventures payment term: funds wired on closing"
    })
  }).then((r) => r.json());
  assert.equal(extract.amount, 600000000);
  assert.equal(extract.payment_date, "2026-10-05");

  const counterparty = await fetch(`${base}/api/graph/counterparty`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      startup_id: "22222222-2222-4222-8222-222222222222",
      counterparty_name: "Seoul Mirae Hospital",
      relationship_type: "recurring",
      renewal_rate: 90,
      network_centrality: 80
    })
  });
  assert.equal(counterparty.status, 200);

  const networkCredit = await fetch(`${base}/api/scores/network-credit/22222222-2222-4222-8222-222222222222`).then((r) => r.json());
  assert.equal(networkCredit.counterparty_risk, "low");
  assert.ok(networkCredit.network_credit_score >= 75);

  const timeToCash = await fetch(`${base}/api/predict/time-to-cash`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ cash_claim_id: "e3333333-3333-4333-8333-333333333333" })
  }).then((r) => r.json());
  assert.ok(timeToCash.p30 <= timeToCash.p60);

  const advanceLimit = await fetch(`${base}/api/advance-limit/recalculate`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      investment_commitment_id: "b1111111-1111-4111-8111-111111111111",
      new_status: "funds_wired"
    })
  }).then((r) => r.json());
  assert.ok(advanceLimit.new_advance_limit > 0);

  const recovery = await fetch(`${base}/api/recovery/analyze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ advance_id: "a2222222-2222-4222-8222-222222222222" })
  }).then((r) => r.json());
  assert.equal(recovery.recommended_option, "A");
  assert.equal(recovery.recommended_option_code, "A_collateral_swap");

  const webhook = await fetch(`${base}/api/webhooks/credential-status-changed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      investment_commitment_id: "b2222222-2222-4222-8222-222222222222",
      new_status: "board_approved",
      signed_by: "mock-chain",
      timestamp: new Date().toISOString()
    })
  }).then((r) => r.json());
  assert.equal(webhook.ok, true);
  assert.ok(webhook.seed_bridge_score > 0);

  const chainStatusFinanced = await fetch(`${base}/api/webhooks/chain-status-changed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cash_claim_id: "e2222222-2222-4222-8222-222222222222",
      new_chain_status: "FINANCED",
      timestamp: new Date().toISOString()
    })
  }).then((r) => r.json());
  assert.equal(chainStatusFinanced.ok, true);
  assert.equal(chainStatusFinanced.chain_status, "FINANCED");
  assert.equal(chainStatusFinanced.financing_status, "FINANCED");
  assert.deepEqual(chainStatusFinanced.advance_ids, []);
  assert.deepEqual(chainStatusFinanced.recoveries, []);

  // e1111111 is the duplicate-financing demo seed: one claim backing TWO
  // advances (a1111111 "active", a5555555 already "in_recovery"). Revoking
  // it must move only the still-active a1111111 into recovery and leave
  // a5555555 (already in_recovery) alone rather than re-processing it.
  const chainStatusRevoked = await fetch(`${base}/api/webhooks/chain-status-changed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cash_claim_id: "e1111111-1111-4111-8111-111111111111",
      new_chain_status: "REVOKED",
      timestamp: new Date().toISOString()
    })
  }).then((r) => r.json());
  assert.equal(chainStatusRevoked.ok, true);
  assert.equal(chainStatusRevoked.chain_status, "REVOKED");
  assert.deepEqual(chainStatusRevoked.advance_ids, ["a1111111-1111-4111-8111-111111111111"]);
  assert.equal(chainStatusRevoked.recoveries.length, 1);
  assert.equal(chainStatusRevoked.recoveries[0].advance_id, "a1111111-1111-4111-8111-111111111111");
  assert.ok(["A", "B", "C", "D"].includes(chainStatusRevoked.recoveries[0].recommended_option));

  // e4444444's sole advance (a4444444) is already "in_recovery" in the seed,
  // so revoking it a second time must find no active advances and return
  // empty arrays instead of re-processing the already-recovering advance.
  const chainStatusRevokedAgain = await fetch(`${base}/api/webhooks/chain-status-changed`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      cash_claim_id: "e4444444-4444-4444-8444-444444444444",
      new_chain_status: "REVOKED",
      timestamp: new Date().toISOString()
    })
  }).then((r) => r.json());
  assert.equal(chainStatusRevokedAgain.ok, true);
  assert.deepEqual(chainStatusRevokedAgain.advance_ids, []);
  assert.deepEqual(chainStatusRevokedAgain.recoveries, []);
});
