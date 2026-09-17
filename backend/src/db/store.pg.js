const crypto = require("node:crypto");
const { Pool } = require("pg");
const { loadSeedData } = require("./store.memory");

const TABLES = [
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

const COLUMNS = {
  startups: ["id", "name", "stage", "monthly_burn", "current_cash", "runway_months"],
  investors: ["id", "name", "track_record_score"],
  investment_commitments: ["id", "startup_id", "investor_id", "committed_amount", "expected_closing_date", "status", "credential_id"],
  counterparties: ["id", "startup_id", "name", "relationship_type", "renewal_rate", "network_centrality"],
  invoices: ["id", "startup_id", "counterparty_id", "amount", "due_date", "paid_date", "historical_delay_days"],
  cash_claims: ["id", "startup_id", "source_type", "source_id", "issuer", "document_hash", "chain_status", "financing_status", "verified_on_chain"],
  ai_scores: ["id", "cash_claim_id", "payment_probability", "expected_settlement_days", "counterparty_risk", "duplicate_financing", "seed_bridge_score", "network_credit_score", "computed_at"],
  advances: ["id", "cash_claim_id", "advance_amount", "status"],
  recovery_events: ["id", "advance_id", "triggered_at", "snapshot_outstanding_bridge", "snapshot_current_cash", "snapshot_verified_receivables", "snapshot_monthly_burn", "snapshot_runway_months", "recommended_option"]
};

const NUMERIC_COLUMNS = new Set([
  "monthly_burn",
  "current_cash",
  "runway_months",
  "track_record_score",
  "committed_amount",
  "renewal_rate",
  "network_centrality",
  "amount",
  "historical_delay_days",
  "payment_probability",
  "expected_settlement_days",
  "seed_bridge_score",
  "network_credit_score",
  "advance_amount",
  "snapshot_outstanding_bridge",
  "snapshot_current_cash",
  "snapshot_verified_receivables",
  "snapshot_monthly_burn",
  "snapshot_runway_months"
]);

const DATE_COLUMNS = new Set(["expected_closing_date", "due_date", "paid_date"]);

function dateOnly(value) {
  if (!value) return value;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeRow(row) {
  const normalized = {};
  for (const [key, value] of Object.entries(row)) {
    if (NUMERIC_COLUMNS.has(key)) {
      normalized[key] = value === null || value === undefined ? null : Number(value);
    } else if (DATE_COLUMNS.has(key)) {
      normalized[key] = dateOnly(value);
    } else if (value instanceof Date) {
      normalized[key] = value.toISOString();
    } else {
      normalized[key] = value;
    }
  }
  return normalized;
}

function createPoolConfig() {
  if (process.env.DATABASE_URL) return { connectionString: process.env.DATABASE_URL };
  return {
    host: process.env.PGHOST || process.env.POSTGRES_HOST || "127.0.0.1",
    port: Number(process.env.PGPORT || process.env.POSTGRES_PORT || 55432),
    database: process.env.PGDATABASE || process.env.POSTGRES_DB || "cashgapbank",
    user: process.env.PGUSER || process.env.POSTGRES_USER || "cashgapbank",
    password: process.env.PGPASSWORD || process.env.POSTGRES_PASSWORD || "cashgapbank_dev_password"
  };
}

async function loadSnapshot(pool) {
  const snapshot = {};
  for (const table of TABLES) {
    const result = await pool.query(`SELECT * FROM ${table}`);
    snapshot[table] = result.rows.map(normalizeRow);
  }
  return snapshot;
}

function valuesFor(table, record) {
  const columns = COLUMNS[table] || Object.keys(record);
  return columns.filter((column) => Object.prototype.hasOwnProperty.call(record, column));
}

function createPostgresStore(initial = loadSeedData(), options = {}) {
  const data = structuredClone(initial);
  const pool = options.pool || new Pool(createPoolConfig());
  let suppressDirectPersistence = false;
  const store = {
    backend: "pg",
    data,
    pool,
    ready: null,
    lastError: null,
    find(table, id) {
      return data[table]?.find((row) => row.id === id) || null;
    },
    where(table, predicate) {
      return (data[table] || []).filter(predicate);
    },
    insert(table, row) {
      if (!data[table]) data[table] = [];
      const record = attachPersistence(table, normalizeRow({ id: crypto.randomUUID(), ...row }));
      data[table].push(record);
      const columns = valuesFor(table, record);
      const placeholders = columns.map((_, index) => `$${index + 1}`);
      const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders.join(", ")})`;
      store.ready = store.ready
        .then(() => pool.query(sql, columns.map((column) => record[column])))
        .catch((error) => {
          store.lastError = error;
        });
      return record;
    },
    update(table, id, patch) {
      const row = this.find(table, id);
      if (!row) return null;
      suppressDirectPersistence = true;
      Object.assign(row, normalizeRow(patch));
      suppressDirectPersistence = false;
      const columns = valuesFor(table, patch).filter((column) => column !== "id");
      if (!columns.length) return row;
      const assignments = columns.map((column, index) => `${column} = $${index + 1}`);
      const sql = `UPDATE ${table} SET ${assignments.join(", ")} WHERE id = $${columns.length + 1}`;
      store.ready = store.ready
        .then(() => pool.query(sql, [...columns.map((column) => row[column]), id]))
        .catch((error) => {
          store.lastError = error;
        });
      return row;
    }
  };

  function enqueueQuery(sql, values) {
    store.ready = store.ready
      .then(() => pool.query(sql, values))
      .catch((error) => {
        store.lastError = error;
      });
  }

  function attachPersistence(table, row) {
    if (!row || typeof row !== "object") return row;
    const columns = new Set(COLUMNS[table] || []);
    return new Proxy(row, {
      set(target, property, value) {
        const key = String(property);
        target[property] = value;
        if (!suppressDirectPersistence && key !== "id" && columns.has(key) && target.id) {
          enqueueQuery(`UPDATE ${table} SET ${key} = $1 WHERE id = $2`, [value, target.id]);
        }
        return true;
      }
    });
  }

  store.ready = loadSnapshot(pool)
    .then((snapshot) => {
      for (const table of TABLES) data[table] = (snapshot[table] || []).map((row) => attachPersistence(table, row));
      return data;
    })
    .catch((error) => {
      store.lastError = error;
      if ((process.env.STORE_BACKEND || "").toLowerCase() === "pg") {
        console.warn(`PostgreSQL store unavailable; using seed cache until DB is reachable: ${error.message}`);
      } else if (typeof pool.end === "function") {
        pool.end().catch(() => {});
        store.backend = "memory";
      }
      return data;
    });

  return store;
}

module.exports = { createPostgresStore, createPoolConfig, loadSnapshot, TABLES };
