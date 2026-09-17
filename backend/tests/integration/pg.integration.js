const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { Pool } = require("pg");

const env = {
  ...process.env,
  STORE_BACKEND: "pg",
  DOCKER_CONTEXT: process.env.DOCKER_CONTEXT || "desktop-linux",
  POSTGRES_HOST: process.env.POSTGRES_HOST || "127.0.0.1",
  POSTGRES_DB: process.env.POSTGRES_DB || "cashgapbank",
  POSTGRES_USER: process.env.POSTGRES_USER || "cashgapbank",
  POSTGRES_PASSWORD: process.env.POSTGRES_PASSWORD || "cashgapbank_dev_password",
  POSTGRES_PORT: process.env.POSTGRES_PORT || "55432",
  SEED_SQL_PATH: process.env.SEED_SQL_PATH || "../data/seed/sql",
  AI_SERVICE_PORT: process.env.AI_SERVICE_PORT || "8000"
};
const AI_SERVICE_URL = `http://127.0.0.1:${env.AI_SERVICE_PORT}`;

function run(command, args, options = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    cwd: process.cwd(),
    env,
    stdio: options.stdio || "inherit"
  });
}

function makePool() {
  return new Pool({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT),
    database: env.POSTGRES_DB,
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD
  });
}

async function waitForPostgres() {
  const deadline = Date.now() + 60_000;
  let lastError;
  while (Date.now() < deadline) {
    const pool = makePool();
    try {
      await pool.query("SELECT 1");
      await pool.end();
      return;
    } catch (error) {
      lastError = error;
      await pool.end().catch(() => {});
      await delay(1000);
    }
  }
  throw lastError || new Error("PostgreSQL did not become ready");
}

async function waitForAiService() {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${AI_SERVICE_URL}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await delay(1000);
  }
  throw new Error("ai-service did not become ready");
}

async function tableCounts(pool) {
  const tables = [
    "startups",
    "investors",
    "investment_commitments",
    "counterparties",
    "invoices",
    "cash_claims",
    "ai_scores",
    "advances",
    "recovery_events"
  ];
  const counts = {};
  for (const table of tables) {
    const result = await pool.query(`SELECT COUNT(*)::int AS count FROM ${table}`);
    counts[table] = result.rows[0].count;
  }
  return counts;
}

async function postJson(baseUrl, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await response.json();
  assert.ok(response.ok, `${path} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function getJson(baseUrl, path) {
  const response = await fetch(`${baseUrl}${path}`);
  const payload = await response.json();
  assert.ok(response.ok, `${path} failed ${response.status}: ${JSON.stringify(payload)}`);
  return payload;
}

async function main() {
  run("docker", ["compose", "down", "-v"]);
  run("docker", ["compose", "up", "-d"]);
  await waitForPostgres();
  await waitForAiService();

  const pool = makePool();
  try {
    const counts = await tableCounts(pool);
    const expectedCounts = {
      startups: 4,
      investors: 4,
      investment_commitments: 4,
      counterparties: 7,
      invoices: 7,
      cash_claims: 7,
      ai_scores: 7,
      advances: 6,
      recovery_events: 4
    };
    assert.deepEqual(counts, expectedCounts);
    console.log("Seed row counts:", JSON.stringify(counts));

    const chainStatusRows = await pool.query(
      "SELECT chain_status, COUNT(*)::int AS count FROM cash_claims GROUP BY chain_status ORDER BY chain_status"
    );
    const chainStatusCounts = Object.fromEntries(chainStatusRows.rows.map((row) => [row.chain_status, row.count]));
    assert.deepEqual(chainStatusCounts, {
      FINANCED: 1,
      REGISTERED: 1,
      REVOKED: 3,
      SETTLED: 1,
      VERIFIED: 1
    });
    console.log("chain_status distribution:", JSON.stringify(chainStatusCounts));

    process.env.STORE_BACKEND = "pg";
    process.env.POSTGRES_HOST = env.POSTGRES_HOST;
    process.env.POSTGRES_DB = env.POSTGRES_DB;
    process.env.POSTGRES_USER = env.POSTGRES_USER;
    process.env.POSTGRES_PASSWORD = env.POSTGRES_PASSWORD;
    process.env.POSTGRES_PORT = env.POSTGRES_PORT;
    process.env.AI_SERVICE_URL = AI_SERVICE_URL;
    delete process.env.CHAIN_VERIFY_URL;

    const { start, store } = require("../../src/api/server");
    await store.ready;
    assert.equal(store.backend, "pg");

    const server = start(0);
    await new Promise((resolve) => server.once("listening", resolve));
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const checked = [];

    try {
      const health = await getJson(baseUrl, "/health");
      assert.equal(health.ok, true);
      checked.push("GET /health");

      const network = await getJson(baseUrl, "/api/scores/network-credit/22222222-2222-4222-8222-222222222222");
      assert.equal(network.counterparty_risk, "low");
      // 70 matches the riskFromScore() "low" threshold used to aggregate
      // per-counterparty ai-service scores in src/api/server.js. The old
      // >=75 expectation came from the deleted hand-rolled JS formula and no
      // longer holds against the real trained network-credit model's
      // portfolio-average score.
      assert.ok(network.network_credit_score >= 70, `expected >=70, got ${network.network_credit_score}`);
      checked.push("GET /api/scores/network-credit/:startupId");

      const seedBridge = await getJson(baseUrl, "/api/scores/seed-bridge/b1111111-1111-4111-8111-111111111111");
      assert.equal(seedBridge.seed_bridge_score, 81);
      assert.ok(typeof seedBridge.funding_probability === "number");
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(seedBridge.expected_closing));
      assert.ok(seedBridge.recommended_advance_capacity > 0);
      checked.push("GET /api/scores/seed-bridge/:commitmentId (funding_probability/expected_closing/recommended_advance_capacity present)");

      const beforeAdvances = await pool.query("SELECT COUNT(*)::int AS count FROM advances");
      const claim = await postJson(baseUrl, "/api/cash-claims", {
        startup_id: "22222222-2222-4222-8222-222222222222",
        source_type: "invoice",
        source_id: "d1111111-1111-4111-8111-111111111111",
        document_text: "Invoice amount KRW 180,000,000 counterparty: Samsung SDS AI Transformation PoC Team payment term: net 30 termination clause: standard convenience termination conditions precedent: delivery acceptance payment date 2026-10-15"
      });
      assert.equal(claim.verified_on_chain, true);
      assert.ok(claim.advance_id);
      await store.ready;
      const advanceRow = await pool.query("SELECT id, cash_claim_id, advance_amount, status FROM advances WHERE id = $1", [claim.advance_id]);
      assert.equal(advanceRow.rowCount, 1);
      assert.equal(advanceRow.rows[0].status, "active");
      const afterAdvances = await pool.query("SELECT COUNT(*)::int AS count FROM advances");
      assert.equal(afterAdvances.rows[0].count, beforeAdvances.rows[0].count + 1);
      checked.push("POST /api/cash-claims");

      const recoveryCases = [
        ["a2222222-2222-4222-8222-222222222222", "A", "A_collateral_swap"],
        ["a4444444-4444-4444-8444-444444444444", "B", "B_installment"],
        ["a5555555-5555-4555-8555-555555555555", "C", "C_investor_match"],
        ["a6666666-6666-4666-8666-666666666666", "D", "D_partial_restructure"]
      ];
      const recoveryResults = [];
      for (const [advance_id, recommended_option, recommended_option_code] of recoveryCases) {
        const result = await postJson(baseUrl, "/api/recovery/analyze", { advance_id });
        assert.equal(result.recommended_option, recommended_option);
        assert.equal(result.recommended_option_code, recommended_option_code);
        recoveryResults.push(`${advance_id}:${recommended_option_code}`);
      }
      checked.push("POST /api/recovery/analyze x4");

      const webhook = await postJson(baseUrl, "/api/webhooks/credential-status-changed", {
        investment_commitment_id: "b2222222-2222-4222-8222-222222222222",
        new_status: "funds_wired",
        signed_by: "integration-test",
        timestamp: new Date().toISOString()
      });
      assert.equal(webhook.ok, true);
      await store.ready;
      const statusRow = await pool.query("SELECT status FROM investment_commitments WHERE id = $1", [
        "b2222222-2222-4222-8222-222222222222"
      ]);
      assert.equal(statusRow.rows[0].status, "funds_wired");
      checked.push("write-through Proxy status mutation");

      // chain-status-changed / FINANCED: e2222222 is an investment_commitment
      // claim with no advance, so financing_status should sync but recovery
      // must stay null.
      const financedClaimId = "e2222222-2222-4222-8222-222222222222";
      const financed = await postJson(baseUrl, "/api/webhooks/chain-status-changed", {
        cash_claim_id: financedClaimId,
        new_chain_status: "FINANCED",
        timestamp: new Date().toISOString()
      });
      assert.equal(financed.ok, true);
      assert.equal(financed.chain_status, "FINANCED");
      assert.equal(financed.financing_status, "FINANCED");
      assert.deepEqual(financed.advance_ids, []);
      assert.deepEqual(financed.recoveries, []);
      await store.ready;
      const financedRow = await pool.query("SELECT chain_status, financing_status FROM cash_claims WHERE id = $1", [financedClaimId]);
      assert.equal(financedRow.rows[0].chain_status, "FINANCED");
      assert.equal(financedRow.rows[0].financing_status, "FINANCED");
      checked.push("POST /api/webhooks/chain-status-changed (FINANCED syncs financing_status, no advance -> no recovery)");

      // chain-status-changed / REVOKED, multi-advance claim: e1111111 is the
      // duplicate-financing demo seed - ONE claim backing TWO advances
      // (a1111111 "active", a5555555 already "in_recovery"). Only the
      // active advance must be moved into recovery; the already-in_recovery
      // one must be left alone instead of being re-selected/re-processed.
      const revokedClaimId = "e1111111-1111-4111-8111-111111111111";
      const activeAdvanceId = "a1111111-1111-4111-8111-111111111111";
      const alreadyRecoveringAdvanceId = "a5555555-5555-4555-8555-555555555555";
      const beforeActiveAdvance = await pool.query("SELECT status FROM advances WHERE id = $1", [activeAdvanceId]);
      assert.equal(beforeActiveAdvance.rows[0].status, "active");

      const revoked = await postJson(baseUrl, "/api/webhooks/chain-status-changed", {
        cash_claim_id: revokedClaimId,
        new_chain_status: "REVOKED",
        timestamp: new Date().toISOString()
      });
      assert.equal(revoked.ok, true);
      assert.equal(revoked.chain_status, "REVOKED");
      assert.deepEqual(revoked.advance_ids, [activeAdvanceId]);
      assert.equal(revoked.recoveries.length, 1);
      assert.equal(revoked.recoveries[0].advance_id, activeAdvanceId);
      assert.ok(["A", "B", "C", "D"].includes(revoked.recoveries[0].recommended_option));
      await store.ready;
      const revokedClaimRow = await pool.query("SELECT chain_status FROM cash_claims WHERE id = $1", [revokedClaimId]);
      assert.equal(revokedClaimRow.rows[0].chain_status, "REVOKED");
      const nowActiveAdvance = await pool.query("SELECT status FROM advances WHERE id = $1", [activeAdvanceId]);
      assert.equal(nowActiveAdvance.rows[0].status, "in_recovery");
      const stillRecoveringAdvance = await pool.query("SELECT status FROM advances WHERE id = $1", [alreadyRecoveringAdvanceId]);
      assert.equal(stillRecoveringAdvance.rows[0].status, "in_recovery");
      checked.push("POST /api/webhooks/chain-status-changed (REVOKED on multi-advance claim moves only the active advance into recovery)");

      // chain-status-changed / REVOKED, claim whose sole advance is already
      // in_recovery: must find zero active advances and return empty arrays
      // instead of re-processing an advance that's already recovering.
      const alreadyRevokedClaimId = "e4444444-4444-4444-8444-444444444444";
      const revokedAgain = await postJson(baseUrl, "/api/webhooks/chain-status-changed", {
        cash_claim_id: alreadyRevokedClaimId,
        new_chain_status: "REVOKED",
        timestamp: new Date().toISOString()
      });
      assert.equal(revokedAgain.ok, true);
      assert.deepEqual(revokedAgain.advance_ids, []);
      assert.deepEqual(revokedAgain.recoveries, []);
      checked.push("POST /api/webhooks/chain-status-changed (REVOKED with no active advances returns empty arrays)");

      console.log("Endpoint checks:", JSON.stringify(checked));
      console.log("Recovery checks:", JSON.stringify(recoveryResults));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
