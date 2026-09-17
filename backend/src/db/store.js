const fs = require("node:fs");
const path = require("node:path");
const { createMemoryStore, loadSeedData } = require("./store.memory");

function loadDotEnv(filePath = path.resolve(__dirname, "../../.env")) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...valueParts] = trimmed.split("=");
    if (!process.env[key]) process.env[key] = valueParts.join("=").replace(/^['"]|['"]$/g, "");
  }
}

function shouldUsePostgres() {
  const backend = (process.env.STORE_BACKEND || "auto").toLowerCase();
  if (backend === "memory") return false;
  if (backend === "pg" || backend === "postgres" || backend === "postgresql") return true;
  return Boolean(
    process.env.DATABASE_URL ||
      process.env.PGDATABASE ||
      process.env.PGUSER ||
      process.env.PGPASSWORD ||
      process.env.POSTGRES_DB ||
      process.env.POSTGRES_USER ||
      process.env.POSTGRES_PASSWORD
  );
}

function createStore(initial = loadSeedData()) {
  loadDotEnv();
  if (!shouldUsePostgres()) return createMemoryStore(initial);
  const { createPostgresStore } = require("./store.pg");
  return createPostgresStore(initial);
}

module.exports = { createStore, loadSeedData, loadDotEnv };
