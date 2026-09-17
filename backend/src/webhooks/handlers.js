const aiServiceClient = require("../../engines/aiServiceClient");
const { RECOMMENDED_OPTION_CODE } = aiServiceClient;

function requireFields(body, fields, eventName) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === null || body[field] === "");
  if (missing.length) {
    throw Object.assign(new Error(`${eventName} missing required fields: ${missing.join(", ")}`), { statusCode: 400 });
  }
}

async function recalculateAdvanceLimit(store, investmentCommitmentId, newStatus) {
  const commitment = store.find("investment_commitments", investmentCommitmentId);
  if (!commitment) throw Object.assign(new Error("investment_commitment not found"), { statusCode: 404 });
  if (newStatus) commitment.status = newStatus;
  const result = await aiServiceClient.seedBridge(store, investmentCommitmentId);
  const new_advance_limit = Math.round(commitment.committed_amount * (result.seed_bridge_score / 100) * 0.5);
  return { new_advance_limit, seed_bridge_score: result.seed_bridge_score };
}

function snapshotFromFeatures(advanceId, features) {
  return {
    advance_id: advanceId,
    snapshot_outstanding_bridge: features.outstanding_bridge,
    snapshot_current_cash: features.current_cash,
    snapshot_verified_receivables: features.verified_receivables,
    snapshot_monthly_burn: features.monthly_burn,
    snapshot_runway_months: features.runway_months
  };
}

function featuresFromExistingEvent(store, existingEvent) {
  const advance = store.find("advances", existingEvent.advance_id);
  const claim = store.find("cash_claims", advance?.cash_claim_id);
  const pastInvestmentCount = store.where(
    "investment_commitments",
    (row) => row.startup_id === claim?.startup_id
  ).length;
  return {
    outstanding_bridge: Number(existingEvent.snapshot_outstanding_bridge),
    current_cash: Number(existingEvent.snapshot_current_cash),
    verified_receivables: Number(existingEvent.snapshot_verified_receivables),
    monthly_burn: Number(existingEvent.snapshot_monthly_burn),
    runway_months: Number(existingEvent.snapshot_runway_months),
    past_investment_count: pastInvestmentCount
  };
}

function reasoningFor(response) {
  return `ai-service recovery-policy classifier selected option ${response.recommended_option} with ` +
    `confidence ${response.confidence} (class probabilities: ${JSON.stringify(response.class_probabilities)}).`;
}

async function analyzeRecoveryForAdvance(store, advanceId) {
  // A pre-seeded recovery_event (demo fixtures) carries the frozen snapshot
  // that the scenario was designed around; reuse it instead of the current
  // live DB state so re-running analysis stays reproducible.
  const existingEvent = store.where("recovery_events", (event) => event.advance_id === advanceId).at(-1);
  const snapshot = existingEvent || null;
  const features = existingEvent
    ? featuresFromExistingEvent(store, existingEvent)
    : aiServiceClient.gatherRecoveryFeatures(store, advanceId);

  const response = await aiServiceClient.predictRecoveryOption(features);

  return {
    snapshot: snapshot || snapshotFromFeatures(advanceId, features),
    recommended_option: response.recommended_option,
    recommended_option_code: RECOMMENDED_OPTION_CODE[response.recommended_option],
    confidence: response.confidence,
    class_probabilities: response.class_probabilities,
    reasoning: reasoningFor(response)
  };
}

// A single cash_claim can back more than one advance (e.g. the
// duplicate-financing demo seed: one claim with both an "active" advance and
// an already-"in_recovery" one). Revocation must move every currently
// "active" advance into recovery, not just "the last advance found" -
// otherwise an active advance on a multi-advance claim is silently left
// un-recovered while an already-recovering one gets re-analyzed instead.
async function triggerRecoveryForClaim(store, claimId) {
  const activeAdvances = store.where(
    "advances",
    (row) => row.cash_claim_id === claimId && row.status === "active"
  );
  const recoveries = [];
  for (const advance of activeAdvances) {
    advance.status = "in_recovery";
    const recovery = await analyzeRecoveryForAdvance(store, advance.id);
    recoveries.push({ advance_id: advance.id, ...recovery });
  }
  return recoveries;
}

async function handleCredentialStatusChanged(store, body) {
  requireFields(body, ["investment_commitment_id", "new_status", "signed_by", "timestamp"], "credential-status-changed");
  const recalculation = await recalculateAdvanceLimit(store, body.investment_commitment_id, body.new_status);
  return { ok: true, investment_commitment_id: body.investment_commitment_id, ...recalculation };
}

async function handleCredentialRevoked(store, body) {
  requireFields(body, ["investment_commitment_id", "revoked_by", "reason", "timestamp"], "credential-revoked");
  const commitment = store.find("investment_commitments", body.investment_commitment_id);
  if (!commitment) throw Object.assign(new Error("investment_commitment not found"), { statusCode: 404 });
  commitment.status = "revoked";
  const claim = store.where("cash_claims", (row) => row.source_type === "investment_commitment" && row.source_id === commitment.id).at(-1);
  const recoveries = claim ? await triggerRecoveryForClaim(store, claim.id) : [];
  return {
    ok: true,
    investment_commitment_id: commitment.id,
    advance_ids: recoveries.map((recovery) => recovery.advance_id),
    recoveries
  };
}

// New webhook (spec section 4 / Future Cash Registry): tracks the
// cash_claims.chain_status lifecycle (REGISTERED/VERIFIED/FINANCED/REVOKED/
// SETTLED), which is a separate layer from investment_commitments.status
// (deal-progress, handled by credential-status-changed above).
async function handleChainStatusChanged(store, body) {
  requireFields(body, ["cash_claim_id", "new_chain_status", "timestamp"], "chain-status-changed");
  const claim = store.find("cash_claims", body.cash_claim_id);
  if (!claim) throw Object.assign(new Error("cash_claim not found"), { statusCode: 404 });

  claim.chain_status = body.new_chain_status;
  if (body.new_chain_status === "FINANCED") claim.financing_status = "FINANCED";

  const recoveries = body.new_chain_status === "REVOKED"
    ? await triggerRecoveryForClaim(store, claim.id)
    : [];

  return {
    ok: true,
    cash_claim_id: claim.id,
    chain_status: claim.chain_status,
    financing_status: claim.financing_status,
    advance_ids: recoveries.map((recovery) => recovery.advance_id),
    recoveries
  };
}

module.exports = {
  recalculateAdvanceLimit,
  analyzeRecoveryForAdvance,
  triggerRecoveryForClaim,
  handleCredentialStatusChanged,
  handleCredentialRevoked,
  handleChainStatusChanged,
  requireFields
};
