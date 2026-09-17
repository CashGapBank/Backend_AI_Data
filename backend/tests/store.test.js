const test = require("node:test");
const assert = require("node:assert/strict");
const { createMemoryStore, loadSeedData } = require("../src/db/store.memory");
const { createPostgresStore } = require("../src/db/store.pg");

test("memory store keeps the public store interface", () => {
  const store = createMemoryStore();
  const startup = store.find("startups", "11111111-1111-4111-8111-111111111111");
  assert.equal(startup.name, "LumaLedger AI");

  const row = store.insert("counterparties", {
    startup_id: startup.id,
    name: "Interface Test Counterparty",
    relationship_type: "contract",
    renewal_rate: 70,
    network_centrality: 50
  });
  assert.equal(store.find("counterparties", row.id).name, "Interface Test Counterparty");

  store.update("counterparties", row.id, { renewal_rate: 80 });
  assert.equal(store.find("counterparties", row.id).renewal_rate, 80);
});

test("postgres store preserves the same sync interface over a pg-backed cache", async () => {
  const queries = [];
  const fakePool = {
    async query(sql, values = []) {
      queries.push({ sql, values });
      const tableMatch = sql.match(/^SELECT \* FROM ([a-z_]+)/);
      if (!tableMatch) return { rows: [] };
      return { rows: loadSeedData()[tableMatch[1]] || [] };
    },
    async end() {}
  };

  const store = createPostgresStore(loadSeedData(), { pool: fakePool });
  await store.ready;

  const inserted = store.insert("cash_claims", {
    startup_id: "22222222-2222-4222-8222-222222222222",
    source_type: "invoice",
    source_id: "d1111111-1111-4111-8111-111111111111",
    verified_on_chain: true
  });
  assert.equal(store.find("cash_claims", inserted.id).verified_on_chain, true);

  store.update("cash_claims", inserted.id, { verified_on_chain: false });
  store.find("cash_claims", inserted.id).verified_on_chain = true;
  await store.ready;
  assert.equal(store.find("cash_claims", inserted.id).verified_on_chain, true);
  assert.ok(queries.some((query) => query.sql.startsWith("INSERT INTO cash_claims")));
  assert.ok(queries.some((query) => query.sql.startsWith("UPDATE cash_claims")));
});
