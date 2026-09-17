const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const SEED_PATH = path.resolve(__dirname, "../../../data/seed/json/cash_gap_bank_seed.json");

function loadSeedData() {
  return JSON.parse(fs.readFileSync(SEED_PATH, "utf8"));
}

function createMemoryStore(initial = loadSeedData()) {
  const data = structuredClone(initial);
  return {
    backend: "memory",
    data,
    find(table, id) {
      return data[table]?.find((row) => row.id === id) || null;
    },
    where(table, predicate) {
      return (data[table] || []).filter(predicate);
    },
    insert(table, row) {
      if (!data[table]) data[table] = [];
      const record = { id: crypto.randomUUID(), ...row };
      data[table].push(record);
      return record;
    },
    update(table, id, patch) {
      const row = this.find(table, id);
      if (!row) return null;
      Object.assign(row, patch);
      return row;
    }
  };
}

module.exports = { createMemoryStore, loadSeedData, SEED_PATH };
