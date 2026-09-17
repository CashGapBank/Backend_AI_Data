const http = require("node:http");
const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryStore } = require("../src/db/store.memory");
const aiServiceClient = require("../engines/aiServiceClient");

function startFakeAiService(responsesByPath) {
  const captured = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
    captured.push({ path: req.url, body });
    const response = responsesByPath[req.url];
    if (!response) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ detail: "unmapped path" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(response));
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, captured })));
}

function fixtureStore() {
  return createMemoryStore({
    startups: [
      { id: "s1", name: "Fixture Startup", stage: "growth", monthly_burn: 60000000, current_cash: 200000000, runway_months: 3 }
    ],
    investors: [
      { id: "inv1", name: "Fixture Ventures", track_record_score: 88 }
    ],
    investment_commitments: [
      { id: "ic1", startup_id: "s1", investor_id: "inv1", committed_amount: 400000000, expected_closing_date: "2026-11-01", status: "board_approved", credential_id: "cred1" },
      { id: "ic2", startup_id: "s1", investor_id: "inv1", committed_amount: 100000000, expected_closing_date: "2026-12-01", status: "term_sheet_signed", credential_id: "cred2" }
    ],
    counterparties: [
      { id: "cp1", startup_id: "s1", name: "Samsung SDS AI Transformation PoC Team", relationship_type: "recurring", renewal_rate: 80, network_centrality: 90 },
      { id: "cp2", startup_id: "s1", name: "Seoul Mirae Hospital", relationship_type: "recurring", renewal_rate: 70, network_centrality: 40 },
      { id: "cp3", startup_id: "s1", name: "Some Local Shop", relationship_type: "poc", renewal_rate: 50, network_centrality: 10 }
    ],
    invoices: [
      { id: "inv_old", startup_id: "s1", counterparty_id: "cp1", amount: 50000000, due_date: "2026-09-01", paid_date: "2026-09-01", historical_delay_days: 2 },
      { id: "inv_new", startup_id: "s1", counterparty_id: "cp1", amount: 90000000, due_date: "2026-10-01", paid_date: null, historical_delay_days: 5 }
    ],
    cash_claims: [
      { id: "claim1", startup_id: "s1", source_type: "invoice", source_id: "inv_new", issuer: "Samsung SDS AI Transformation PoC Team", document_hash: "sha256:x", chain_status: "VERIFIED", financing_status: "NOT_FINANCED", verified_on_chain: true }
    ],
    ai_scores: [],
    advances: [
      { id: "adv1", cash_claim_id: "claim1", advance_amount: 30000000, status: "in_recovery" }
    ],
    recovery_events: []
  });
}

test("classifyCounterpartyTier classifies known and heuristic names", () => {
  assert.equal(aiServiceClient.classifyCounterpartyTier("Samsung SDS AI Transformation PoC Team"), "large_corp");
  assert.equal(aiServiceClient.classifyCounterpartyTier("Hyundai AutoEver Connected Services Lab"), "large_corp");
  assert.equal(aiServiceClient.classifyCounterpartyTier("Seoul Mirae Hospital"), "midsize");
  assert.equal(aiServiceClient.classifyCounterpartyTier("Busan Green Clinic Network"), "midsize");
  assert.equal(aiServiceClient.classifyCounterpartyTier("Daejeon Retail Logistics Co."), "general");
  assert.equal(aiServiceClient.classifyCounterpartyTier("A brand-new unseen counterparty"), "general");
  assert.equal(aiServiceClient.classifyCounterpartyTier("LG Household & Health Care"), "large_corp");
  assert.equal(aiServiceClient.classifyCounterpartyTier("Random City Clinic"), "midsize");
});

test("documentIntelligence posts document_text/document_type and returns the parsed response", async (t) => {
  const { server, captured } = await startFakeAiService({
    "/predict/document-intelligence": { amount: 100, counterparty: "Acme", payment_date: "2026-10-01", expected_closing: null, conditions_precedent: [], termination_clause: null, payment_term: "net 30" }
  });
  t.after(() => server.close());
  const previous = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { process.env.AI_SERVICE_URL = previous; });

  const result = await aiServiceClient.documentIntelligence("invoice text", "invoice");
  assert.equal(result.amount, 100);
  assert.deepEqual(captured[0], { path: "/predict/document-intelligence", body: { document_text: "invoice text", document_type: "invoice" } });
});

test("timeToCash joins invoices+counterparties and normalizes network_centrality to 0..1", async (t) => {
  const { server, captured } = await startFakeAiService({
    "/predict/time-to-cash": { payment_probability: 80, expected_settlement_days: 20, p30: 10, p60: 50, p90: 80 }
  });
  t.after(() => server.close());
  const previous = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { process.env.AI_SERVICE_URL = previous; });

  const store = fixtureStore();
  const result = await aiServiceClient.timeToCash(store, "inv_new");
  assert.equal(result.payment_probability, 80);
  assert.deepEqual(captured[0].body, {
    amount: 90000000,
    renewal_rate: 80,
    network_centrality: 0.9,
    relationship_type: "recurring",
    historical_delay_days: 5
  });
});

test("networkCredit computes active_recurring_contracts and counterparty_tier from the DB", async (t) => {
  const { server, captured } = await startFakeAiService({
    "/predict/network-credit": { network_credit_score: 91, counterparty_risk: "low" }
  });
  t.after(() => server.close());
  const previous = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { process.env.AI_SERVICE_URL = previous; });

  const store = fixtureStore();
  const result = await aiServiceClient.networkCredit(store, "s1", "cp1");
  assert.equal(result.counterparty_risk, "low");
  assert.deepEqual(captured[0].body, {
    renewal_rate: 80,
    network_centrality: 0.9,
    relationship_type: "recurring",
    historical_delay_days: 5,
    active_recurring_contracts: 2, // cp1 and cp2 are both relationship_type=recurring for s1
    counterparty_tier: "large_corp",
    amount: 90000000 // most recent unpaid invoice for cp1
  });
});

test("seedBridge joins investment_commitments+investors+startups", async (t) => {
  const { server, captured } = await startFakeAiService({
    "/predict/seed-bridge": {
      seed_bridge_score: 77,
      funding_probability: 60,
      expected_closing: "2026-11-05",
      recommended_advance_capacity: 100000000,
      factors: { investor_trust: 88, diligence_stage: 90, runway: 50, closing_proximity: 80 }
    }
  });
  t.after(() => server.close());
  const previous = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { process.env.AI_SERVICE_URL = previous; });

  const store = fixtureStore();
  const result = await aiServiceClient.seedBridge(store, "ic1");
  assert.equal(result.seed_bridge_score, 77);
  assert.deepEqual(captured[0].body, {
    committed_amount: 400000000,
    expected_closing_date: "2026-11-01",
    investor_track_record_score: 88,
    status: "board_approved",
    runway_months: 3
  });
});

test("recoveryOption assembles outstanding_bridge/current_cash/verified_receivables/monthly_burn/runway_months/past_investment_count", async (t) => {
  const { server, captured } = await startFakeAiService({
    "/predict/recovery-option": { recommended_option: "D", confidence: 0.8, class_probabilities: { A: 0.05, B: 0.05, C: 0.1, D: 0.8 } }
  });
  t.after(() => server.close());
  const previous = process.env.AI_SERVICE_URL;
  process.env.AI_SERVICE_URL = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { process.env.AI_SERVICE_URL = previous; });

  const store = fixtureStore();
  const { features, response } = await aiServiceClient.recoveryOption(store, "adv1");
  assert.equal(response.recommended_option, "D");
  assert.deepEqual(features, {
    outstanding_bridge: 30000000,
    current_cash: 200000000,
    verified_receivables: 90000000, // only the unpaid inv_new counts
    monthly_burn: 60000000,
    runway_months: 3,
    past_investment_count: 2
  });
  assert.deepEqual(captured[0].body, features);
});
