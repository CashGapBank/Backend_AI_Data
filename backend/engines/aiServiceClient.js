const crypto = require("node:crypto");

// ai-service is a pure calculation service with no DB access of its own
// (see cash-gap-bank-spec.md section 7). Every function here does the same
// three-step job: read raw feature columns out of the store, call the
// matching ai-service endpoint with those raw features (never a DB id), and
// return the parsed response. Node owns all DB joins; ai-service only ever
// sees numbers/strings/enums.

function aiServiceBaseUrl() {
  return process.env.AI_SERVICE_URL || "http://127.0.0.1:8000";
}

async function postJson(path, body) {
  const res = await fetch(`${aiServiceBaseUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = payload && payload.detail ? JSON.stringify(payload.detail) : res.statusText;
    throw Object.assign(new Error(`ai-service ${path} failed: HTTP ${res.status} ${detail}`), {
      statusCode: 502
    });
  }
  return payload;
}

function hashDocumentText(text) {
  return `sha256:${crypto.createHash("sha256").update(text || "").digest("hex")}`;
}

// ---- counterparty_tier classification -------------------------------------
// ai-service's network-credit model needs a large_corp/midsize/general tier
// per counterparty but only stores the raw counterparty name in the DB, so
// Node classifies it. Seed data (data repo) names are mapped exactly; any
// other name falls back to a keyword regex using the same signal the old
// JS graph_risk engine used (conglomerate brand names -> large_corp,
// hospital/clinic -> midsize, everything else -> general).
const COUNTERPARTY_TIER_MAP = {
  "samsung sds ai transformation poc team": "large_corp",
  "hyundai autoever connected services lab": "large_corp",
  "seoul mirae hospital": "midsize",
  "busan green clinic network": "midsize",
  "daejeon retail logistics co.": "general",
  "mapo food service cooperative": "general",
  "recovery verified receivables pool": "general"
};
const LARGE_CORP_PATTERN = /samsung|hyundai|\blg\b|\bsk\b|lotte|autoever|\bsds\b/i;
const MIDSIZE_PATTERN = /hospital|clinic|medical|health/i;

function classifyCounterpartyTier(name = "") {
  const key = String(name).trim().toLowerCase();
  if (COUNTERPARTY_TIER_MAP[key]) return COUNTERPARTY_TIER_MAP[key];
  if (LARGE_CORP_PATTERN.test(name)) return "large_corp";
  if (MIDSIZE_PATTERN.test(name)) return "midsize";
  return "general";
}

const RECOMMENDED_OPTION_CODE = {
  A: "A_collateral_swap",
  B: "B_installment",
  C: "C_investor_match",
  D: "D_partial_restructure"
};

// ---- 1. Document Intelligence ----------------------------------------------
async function documentIntelligence(documentText, documentType) {
  return postJson("/predict/document-intelligence", {
    document_text: documentText || "",
    document_type: documentType
  });
}

// ---- shared invoice/counterparty join --------------------------------------
function joinInvoiceCounterparty(store, invoiceId) {
  const invoice = store.find("invoices", invoiceId);
  if (!invoice) throw Object.assign(new Error(`invoice not found: ${invoiceId}`), { statusCode: 404 });
  const counterparty = store.find("counterparties", invoice.counterparty_id);
  if (!counterparty) {
    throw Object.assign(new Error(`counterparty not found for invoice: ${invoiceId}`), { statusCode: 404 });
  }
  return { invoice, counterparty };
}

// ---- 2. Time-to-Cash --------------------------------------------------------
async function timeToCash(store, invoiceId) {
  const { invoice, counterparty } = joinInvoiceCounterparty(store, invoiceId);
  return postJson("/predict/time-to-cash", {
    amount: Number(invoice.amount),
    renewal_rate: Number(counterparty.renewal_rate),
    network_centrality: Number(counterparty.network_centrality) / 100,
    relationship_type: counterparty.relationship_type,
    historical_delay_days: Number(invoice.historical_delay_days ?? 0)
  });
}

// ---- 3. Network Credit -------------------------------------------------------
function mostRelevantInvoiceForCounterparty(store, counterpartyId) {
  const invoices = store.where("invoices", (row) => row.counterparty_id === counterpartyId);
  if (!invoices.length) return null;
  const unpaid = invoices.filter((row) => !row.paid_date);
  const pool = unpaid.length ? unpaid : invoices;
  return pool.slice().sort((a, b) => new Date(a.due_date) - new Date(b.due_date)).at(-1);
}

async function networkCredit(store, startupId, counterpartyId) {
  const counterparty = store.find("counterparties", counterpartyId);
  if (!counterparty) {
    throw Object.assign(new Error(`counterparty not found: ${counterpartyId}`), { statusCode: 404 });
  }
  const invoice = mostRelevantInvoiceForCounterparty(store, counterpartyId);
  const activeRecurringContracts = store.where(
    "counterparties",
    (row) => row.startup_id === startupId && row.relationship_type === "recurring"
  ).length;

  const payload = {
    renewal_rate: Number(counterparty.renewal_rate),
    network_centrality: Number(counterparty.network_centrality) / 100,
    relationship_type: counterparty.relationship_type,
    historical_delay_days: Number(invoice?.historical_delay_days ?? 0),
    active_recurring_contracts: activeRecurringContracts,
    counterparty_tier: classifyCounterpartyTier(counterparty.name)
  };
  if (invoice) payload.amount = Number(invoice.amount);

  return postJson("/predict/network-credit", payload);
}

// ---- 4. Seed Bridge -----------------------------------------------------------
async function seedBridge(store, investmentCommitmentId) {
  const commitment = store.find("investment_commitments", investmentCommitmentId);
  if (!commitment) {
    throw Object.assign(new Error("investment_commitment not found"), { statusCode: 404 });
  }
  const investor = store.find("investors", commitment.investor_id);
  const startup = store.find("startups", commitment.startup_id);
  if (!investor || !startup) {
    throw Object.assign(new Error("investor or startup not found for investment_commitment"), {
      statusCode: 404
    });
  }
  return postJson("/predict/seed-bridge", {
    committed_amount: Number(commitment.committed_amount),
    expected_closing_date: commitment.expected_closing_date,
    investor_track_record_score: Number(investor.track_record_score),
    status: commitment.status,
    runway_months: Number(startup.runway_months)
  });
}

// ---- 5. Recovery Option ---------------------------------------------------------
function gatherRecoveryFeatures(store, advanceId) {
  const advance = store.find("advances", advanceId);
  if (!advance) throw Object.assign(new Error("advance not found"), { statusCode: 404 });
  const claim = store.find("cash_claims", advance.cash_claim_id);
  const startup = store.find("startups", claim?.startup_id);
  if (!startup) throw Object.assign(new Error("startup not found for advance"), { statusCode: 404 });

  const verifiedReceivables = store
    .where("invoices", (row) => row.startup_id === startup.id && !row.paid_date)
    .reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const pastInvestmentCount = store.where(
    "investment_commitments",
    (row) => row.startup_id === startup.id
  ).length;

  return {
    outstanding_bridge: Number(advance.advance_amount),
    current_cash: Number(startup.current_cash),
    verified_receivables: verifiedReceivables,
    monthly_burn: Number(startup.monthly_burn),
    runway_months: Number(startup.runway_months),
    past_investment_count: pastInvestmentCount
  };
}

async function predictRecoveryOption(features) {
  return postJson("/predict/recovery-option", features);
}

async function recoveryOption(store, advanceId) {
  const features = gatherRecoveryFeatures(store, advanceId);
  const response = await predictRecoveryOption(features);
  return { features, response };
}

module.exports = {
  aiServiceBaseUrl,
  hashDocumentText,
  classifyCounterpartyTier,
  RECOMMENDED_OPTION_CODE,
  documentIntelligence,
  timeToCash,
  networkCredit,
  seedBridge,
  gatherRecoveryFeatures,
  predictRecoveryOption,
  recoveryOption
};
