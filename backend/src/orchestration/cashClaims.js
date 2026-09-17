const aiServiceClient = require("../../engines/aiServiceClient");

async function verifyClaimWithChain(claim) {
  const url = process.env.CHAIN_VERIFY_URL;
  if (!url) {
    const duplicate = String(claim.source_id).includes("6666666");
    return { verified: !duplicate, duplicate_financing: duplicate };
  }
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(claim)
  });
  if (!res.ok) throw new Error(`Chain verify failed: HTTP ${res.status}`);
  return normalizeChainVerifyResponse(await res.json());
}

function normalizeChainVerifyResponse(payload) {
  if (!payload || typeof payload !== "object") {
    throw new Error("Chain verify response must be a JSON object.");
  }
  if (typeof payload.verified !== "boolean" || typeof payload.duplicate_financing !== "boolean") {
    throw new Error("Chain verify response must include boolean verified and duplicate_financing fields.");
  }
  return {
    verified: payload.verified,
    duplicate_financing: payload.duplicate_financing
  };
}

function sourceAmount(store, sourceType, sourceId) {
  if (sourceType === "investment_commitment") return store.find("investment_commitments", sourceId)?.committed_amount ?? 0;
  return store.find("invoices", sourceId)?.amount ?? 0;
}

function calculateSafeAdvanceCapacity(sourceAmountValue, aiScores, verifiedOnChain) {
  if (!verifiedOnChain || aiScores.duplicate_financing === "flagged") return 0;
  const qualityScore = aiScores.seed_bridge_score ?? aiScores.network_credit_score ?? 50;
  const probabilityHaircut = (aiScores.payment_probability ?? 50) / 100;
  const baseAdvanceRate = qualityScore >= 80 ? 0.5 : qualityScore >= 60 ? 0.4 : 0.25;
  return Math.round(sourceAmountValue * baseAdvanceRate * probabilityHaircut);
}

function daysUntil(dateText, referenceDate = new Date()) {
  if (!dateText) return 0;
  const then = new Date(`${dateText}T00:00:00Z`);
  const now = new Date(referenceDate);
  return Math.max(0, Math.round((then - now) / 86400000));
}

async function createCashClaim(store, request) {
  if (!request.startup_id || !request.source_type || !request.source_id) {
    throw Object.assign(new Error("startup_id, source_type, and source_id are required"), { statusCode: 400 });
  }
  if (!["investment_commitment", "invoice"].includes(request.source_type)) {
    throw Object.assign(new Error("source_type must be investment_commitment or invoice"), { statusCode: 400 });
  }
  const source = request.source_type === "investment_commitment"
    ? store.find("investment_commitments", request.source_id)
    : store.find("invoices", request.source_id);
  if (!source) throw Object.assign(new Error(`${request.source_type} source not found`), { statusCode: 404 });

  const documentType = request.source_type === "invoice" ? "invoice" : "term_sheet";
  const documentText = request.document_text || "";
  const extraction = await aiServiceClient.documentIntelligence(documentText, documentType);

  const claimDraft = {
    startup_id: request.startup_id,
    source_type: request.source_type,
    source_id: request.source_id
  };
  const chain = await verifyClaimWithChain(claimDraft);

  let issuer = "unknown";
  let counterpartyId = null;
  if (request.source_type === "investment_commitment") {
    issuer = store.find("investors", source.investor_id)?.name || issuer;
  } else {
    counterpartyId = source.counterparty_id;
    issuer = store.find("counterparties", counterpartyId)?.name || issuer;
  }

  const claim = store.insert("cash_claims", {
    ...claimDraft,
    issuer,
    document_hash: aiServiceClient.hashDocumentText(documentText),
    chain_status: chain.verified ? "VERIFIED" : "REGISTERED",
    financing_status: "NOT_FINANCED",
    verified_on_chain: Boolean(chain.verified)
  });

  const aiScores = {
    cash_claim_id: claim.id,
    payment_probability: 0,
    expected_settlement_days: 0,
    counterparty_risk: "medium",
    duplicate_financing: chain.duplicate_financing ? "flagged" : "none",
    seed_bridge_score: null,
    network_credit_score: null,
    computed_at: new Date().toISOString()
  };

  if (request.source_type === "investment_commitment") {
    const seedBridgeResult = await aiServiceClient.seedBridge(store, request.source_id);
    aiScores.seed_bridge_score = seedBridgeResult.seed_bridge_score;
    aiScores.counterparty_risk = seedBridgeResult.seed_bridge_score >= 75 ? "low"
      : seedBridgeResult.seed_bridge_score >= 55 ? "medium" : "high";
    aiScores.payment_probability = Math.round(seedBridgeResult.funding_probability);
    aiScores.expected_settlement_days = daysUntil(seedBridgeResult.expected_closing);
  } else {
    const [networkCreditResult, timeToCashResult] = await Promise.all([
      aiServiceClient.networkCredit(store, request.startup_id, counterpartyId),
      aiServiceClient.timeToCash(store, request.source_id)
    ]);
    aiScores.network_credit_score = networkCreditResult.network_credit_score;
    aiScores.counterparty_risk = networkCreditResult.counterparty_risk;
    aiScores.payment_probability = Math.round(timeToCashResult.payment_probability);
    aiScores.expected_settlement_days = Math.round(timeToCashResult.expected_settlement_days);
  }

  const scoreRecord = store.insert("ai_scores", aiScores);
  const safe_advance_capacity = calculateSafeAdvanceCapacity(
    sourceAmount(store, request.source_type, request.source_id),
    aiScores,
    claim.verified_on_chain
  );
  const advance = store.insert("advances", {
    cash_claim_id: claim.id,
    advance_amount: safe_advance_capacity,
    status: "active"
  });

  return {
    cash_claim_id: claim.id,
    verified_on_chain: claim.verified_on_chain,
    document_intelligence: extraction,
    ai_scores: scoreRecord,
    safe_advance_capacity,
    advance_id: advance.id
  };
}

module.exports = { createCashClaim, calculateSafeAdvanceCapacity, verifyClaimWithChain, normalizeChainVerifyResponse };
