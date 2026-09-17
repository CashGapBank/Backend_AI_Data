const http = require("node:http");
const { URL } = require("node:url");
const { createStore } = require("../db/store");
const aiServiceClient = require("../../engines/aiServiceClient");
const { createCashClaim } = require("../orchestration/cashClaims");
const {
  recalculateAdvanceLimit,
  analyzeRecoveryForAdvance,
  handleCredentialStatusChanged,
  handleCredentialRevoked,
  handleChainStatusChanged
} = require("../webhooks/handlers");

const store = createStore();

function json(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch (error) {
    throw Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 });
  }
}

async function resolveDocumentText({ document_text, document_url }) {
  if (document_text && document_text.trim()) return document_text;
  if (!document_url) return "";
  if (!/^https?:\/\//i.test(document_url)) return document_url;
  const response = await fetch(document_url);
  if (!response.ok) throw new Error(`Document URL fetch failed: HTTP ${response.status}`);
  return response.text();
}

// GET /api/scores/network-credit/{startup_id} (spec section 2) is a
// portfolio-level view, but ai-service's network-credit model scores one
// counterparty at a time (spec section 7). Node fans the call out per
// counterparty and rolls the results up so the public API contract is
// unchanged.
function riskFromScore(score) {
  if (score >= 70) return "low";
  if (score >= 40) return "medium";
  return "high";
}

async function aggregateNetworkCredit(startupId) {
  const counterparties = store.where("counterparties", (row) => row.startup_id === startupId);
  if (!counterparties.length) {
    return { network_credit_score: 0, counterparty_risk: "high", network_centrality: 0 };
  }
  const results = await Promise.all(
    counterparties.map((counterparty) => aiServiceClient.networkCredit(store, startupId, counterparty.id))
  );
  const avgScore = results.reduce((sum, r) => sum + r.network_credit_score, 0) / results.length;
  const avgCentrality = counterparties.reduce((sum, c) => sum + Number(c.network_centrality || 0), 0) / counterparties.length;
  return {
    network_credit_score: Math.round(avgScore * 10) / 10,
    counterparty_risk: riskFromScore(avgScore),
    network_centrality: Math.round(avgCentrality)
  };
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });

    if (req.method === "POST" && url.pathname === "/api/document-intelligence/extract") {
      const body = await readJson(req);
      const documentText = await resolveDocumentText(body);
      return json(res, 200, await aiServiceClient.documentIntelligence(documentText, body.document_type));
    }

    if (req.method === "POST" && url.pathname === "/api/graph/counterparty") {
      const body = await readJson(req);
      if (!body.startup_id || !body.counterparty_name) {
        throw Object.assign(new Error("startup_id and counterparty_name are required"), { statusCode: 400 });
      }
      const existing = store.where("counterparties", (row) => row.startup_id === body.startup_id && row.name === body.counterparty_name).at(-1);
      const patch = {
        startup_id: body.startup_id,
        name: body.counterparty_name,
        relationship_type: body.relationship_type || "contract",
        renewal_rate: Number(body.renewal_rate ?? 0),
        network_centrality: Number(body.network_centrality ?? 50)
      };
      if (existing) return json(res, 200, store.update("counterparties", existing.id, patch));
      const row = store.insert("counterparties", {
        ...patch
      });
      return json(res, 201, row);
    }

    const networkMatch = url.pathname.match(/^\/api\/scores\/network-credit\/([^/]+)$/);
    if (req.method === "GET" && networkMatch) {
      return json(res, 200, await aggregateNetworkCredit(networkMatch[1]));
    }

    if (req.method === "POST" && url.pathname === "/api/predict/time-to-cash") {
      const body = await readJson(req);
      const claim = store.find("cash_claims", body.cash_claim_id);
      if (!claim) throw Object.assign(new Error("cash_claim not found"), { statusCode: 404 });
      if (claim.source_type !== "invoice") {
        throw Object.assign(new Error("time-to-cash prediction requires an invoice-sourced cash_claim"), { statusCode: 400 });
      }
      return json(res, 200, await aiServiceClient.timeToCash(store, claim.source_id));
    }

    const seedMatch = url.pathname.match(/^\/api\/scores\/seed-bridge\/([^/]+)$/);
    if (req.method === "GET" && seedMatch) return json(res, 200, await aiServiceClient.seedBridge(store, seedMatch[1]));

    if (req.method === "POST" && url.pathname === "/api/cash-claims") {
      return json(res, 201, await createCashClaim(store, await readJson(req)));
    }

    if (req.method === "POST" && url.pathname === "/api/advance-limit/recalculate") {
      const body = await readJson(req);
      return json(res, 200, await recalculateAdvanceLimit(store, body.investment_commitment_id, body.new_status));
    }

    if (req.method === "POST" && url.pathname === "/api/recovery/analyze") {
      const body = await readJson(req);
      if (!body.advance_id) throw Object.assign(new Error("advance_id is required"), { statusCode: 400 });
      return json(res, 200, await analyzeRecoveryForAdvance(store, body.advance_id));
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/credential-status-changed") {
      return json(res, 200, await handleCredentialStatusChanged(store, await readJson(req)));
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/credential-revoked") {
      return json(res, 200, await handleCredentialRevoked(store, await readJson(req)));
    }

    if (req.method === "POST" && url.pathname === "/api/webhooks/chain-status-changed") {
      return json(res, 200, await handleChainStatusChanged(store, await readJson(req)));
    }

    return json(res, 404, { error: "not found" });
  } catch (error) {
    return json(res, error.statusCode || 500, { error: error.message });
  }
}

function start(port = process.env.PORT || 4000) {
  const server = http.createServer(route);
  server.listen(port, () => {
    console.log(`Cash Gap Bank API listening on http://127.0.0.1:${port}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { start, route, store };
