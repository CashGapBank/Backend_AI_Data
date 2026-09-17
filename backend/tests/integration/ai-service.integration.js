// Full end-to-end check against the REAL cash-gap-bank-ai-service (not a
// mock). Spawns the trained FastAPI service from the sibling ai-service repo
// using its .venv, points engines/aiServiceClient.js at it, and re-runs the
// same scenario the unit tests only mock:
//   - the 4 recovery_events fixtures (A/B/C/D) still land on the intended
//     waterfall option once routed through the trained recovery-option model
//   - seed-bridge / network-credit / time-to-cash return plausible values
// Not part of `npm test` (like test:integration:pg) because it needs the
// Python venv; run explicitly with `npm run test:integration:ai`.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");

const AI_SERVICE_DIR = path.resolve(__dirname, "../../../ai-service");
const AI_SERVICE_PORT = process.env.AI_SERVICE_TEST_PORT || 8098;
const AI_SERVICE_URL = `http://127.0.0.1:${AI_SERVICE_PORT}`;

function resolveVenvPython() {
  const candidates = [
    path.join(AI_SERVICE_DIR, ".venv", "Scripts", "python.exe"),
    path.join(AI_SERVICE_DIR, ".venv", "bin", "python")
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

async function waitForHealth(timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${AI_SERVICE_URL}/health`);
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await delay(500);
  }
  return false;
}

async function main() {
  const python = resolveVenvPython();
  if (!python) {
    console.log(`Skipping: no ai-service .venv found under ${AI_SERVICE_DIR}`);
    return;
  }

  process.env.AI_SERVICE_URL = AI_SERVICE_URL;
  process.env.STORE_BACKEND = "memory";

  const aiService = spawn(python, ["-m", "uvicorn", "service.main:app", "--host", "127.0.0.1", "--port", String(AI_SERVICE_PORT)], {
    cwd: AI_SERVICE_DIR,
    stdio: "inherit"
  });

  try {
    const healthy = await waitForHealth();
    assert.ok(healthy, "ai-service did not become healthy in time");

    const aiServiceClient = require("../../engines/aiServiceClient");
    const { loadSeedData } = require("../../src/db/store.memory");
    const { createMemoryStore } = require("../../src/db/store.memory");
    const store = createMemoryStore(loadSeedData());

    // 1. recovery_events fixtures: A/B/C/D waterfall must survive the real
    // trained GradientBoostingClassifier.
    const expected = {
      a2222222: "A",
      a4444444: "B",
      a5555555: "C",
      a6666666: "D"
    };
    for (const event of store.data.recovery_events) {
      const advance = store.find("advances", event.advance_id);
      const features = {
        outstanding_bridge: Number(event.snapshot_outstanding_bridge),
        current_cash: Number(event.snapshot_current_cash),
        verified_receivables: Number(event.snapshot_verified_receivables),
        monthly_burn: Number(event.snapshot_monthly_burn),
        runway_months: Number(event.snapshot_runway_months),
        past_investment_count: store.where(
          "investment_commitments",
          (row) => row.startup_id === store.find("cash_claims", advance.cash_claim_id)?.startup_id
        ).length
      };
      const response = await aiServiceClient.predictRecoveryOption(features);
      const shortId = advance.id.slice(0, 8);
      assert.equal(response.recommended_option, expected[shortId], `advance ${advance.id} expected ${expected[shortId]}, got ${response.recommended_option}`);
    }
    console.log("recovery_events A/B/C/D fixtures: OK");

    // 2. seed-bridge sanity (score in range, factors present).
    const seedBridgeResult = await aiServiceClient.seedBridge(store, "b1111111-1111-4111-8111-111111111111");
    assert.ok(seedBridgeResult.seed_bridge_score >= 70 && seedBridgeResult.seed_bridge_score <= 90);
    assert.ok(seedBridgeResult.factors);
    console.log("seed-bridge sanity: OK", seedBridgeResult);

    // 3. network-credit for CareLink Ops' strongest counterparty (Samsung SDS PoC).
    const networkCreditResult = await aiServiceClient.networkCredit(
      store,
      "22222222-2222-4222-8222-222222222222",
      "c1111111-1111-4111-8111-111111111111"
    );
    assert.ok(["low", "medium", "high"].includes(networkCreditResult.counterparty_risk));
    console.log("network-credit sanity: OK", networkCreditResult);

    // 4. time-to-cash for a real invoice-sourced claim.
    const timeToCashResult = await aiServiceClient.timeToCash(store, "d1111111-1111-4111-8111-111111111111");
    assert.ok(timeToCashResult.p30 <= timeToCashResult.p60 && timeToCashResult.p60 <= timeToCashResult.p90);
    console.log("time-to-cash sanity: OK", timeToCashResult);

    // 5. document-intelligence heuristic fallback (no ANTHROPIC_API_KEY in test env).
    const extraction = await aiServiceClient.documentIntelligence(
      "Invoice amount KRW 180,000,000 counterparty: Samsung SDS AI Transformation PoC Team payment term: net 30",
      "invoice"
    );
    assert.ok(extraction.amount === 180000000 || extraction.amount === null);
    console.log("document-intelligence sanity: OK", extraction);

    console.log("All ai-service integration checks passed.");
  } finally {
    aiService.kill();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
