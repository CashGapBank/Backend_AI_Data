# Cash Gap Bank Backend

Backend for Cash Gap Bank: orchestration, REST API, PostgreSQL migrations, blockchain verification mock, and credential webhook sender mock. All AI scoring (Document Intelligence, Time-to-Cash, Network Credit, Seed Bridge, Recovery Policy) is delegated to the separate `cash-gap-bank-ai-service` (Python/FastAPI, sibling repo) — there is no hardcoded scoring logic in this repo.

## Run

```bash
npm test
npm run mock:chain
# start ai-service separately, e.g. from the ai-service repo:
#   .venv/Scripts/python -m uvicorn service.main:app --port 8000
CHAIN_VERIFY_URL=http://127.0.0.1:4010/chain/verify-claim AI_SERVICE_URL=http://127.0.0.1:8000 npm run dev
```

Default API port is `4000`.

## Environment Variables

Create a local env file from the example:

```bash
cp .env.example .env
```

The example file documents every environment variable read by the backend:

```dotenv
PORT=4000
STORE_BACKEND=auto
DATABASE_URL=
POSTGRES_HOST=127.0.0.1
POSTGRES_DB=cashgapbank
POSTGRES_USER=cashgapbank
POSTGRES_PASSWORD=cashgapbank_dev_password
POSTGRES_PORT=55432
SEED_SQL_PATH=../cash-gap-bank-data/seed/sql
ANTHROPIC_API_KEY=
ANTHROPIC_MODEL=claude-3-5-sonnet-latest
CHAIN_VERIFY_URL=
AI_SERVICE_URL=http://127.0.0.1:8000
AI_SERVICE_PORT=8000
MOCK_CHAIN_PORT=4010
API_BASE_URL=http://127.0.0.1:4000
```

`STORE_BACKEND=auto` uses PostgreSQL when DB connection variables are present and otherwise uses the local memory store. Set `STORE_BACKEND=memory` for DB-free local tests, or `STORE_BACKEND=pg` to force the PostgreSQL-backed store.

`CHAIN_VERIFY_URL` is the only switch needed to replace the mock blockchain verifier with the real blockchain team API. The expected response shape is `{ "verified": boolean, "duplicate_financing": boolean }`.

### Future Cash Registry (chain_status)

Migration `003_future_cash_registry.sql` adds `cash_claims.issuer`, `.document_hash`, `.chain_status` (`REGISTERED`/`VERIFIED`/`FINANCED`/`REVOKED`/`SETTLED`), and `.financing_status` (`NOT_FINANCED`/`FINANCED`) per `cash-gap-bank-spec.md` section 1/6. This is a separate layer from `investment_commitments.status` (deal-progress stage) — do not conflate the two.

`POST /api/webhooks/chain-status-changed` (`{ cash_claim_id, new_chain_status, timestamp }`) updates `chain_status`, syncs `financing_status` to `FINANCED` when `new_chain_status` is `FINANCED`, and — like the existing `credential-revoked` webhook — triggers `/api/recovery/analyze` when `new_chain_status` is `REVOKED`. Simulate it with `npm run mock:webhook -- chain-status <cash_claim_id> <NEW_STATUS>`.

## PostgreSQL

Defaults are for local development. `SEED_SQL_PATH` is relative to this backend directory. If the data repo is checked out somewhere else, update that value in `.env` to point at its `seed/sql` folder.

Start PostgreSQL:

```bash
docker compose up -d
```

On the first database initialization, Docker runs `src/db/migrations/*.sql` first and then runs the SQL files from `SEED_SQL_PATH`. The database is exposed on `127.0.0.1:${POSTGRES_PORT:-55432}`.

To reset the demo data back to the initial scenario state, remove the database volume and start it again:

```bash
docker compose down -v
docker compose up -d
```

Plain container restarts keep the existing `postgres_data` volume, so data will not reset unless the volume is removed.

## ai-service integration

`engines/aiServiceClient.js` is the only place in this repo that talks to the AI. It is a mapping layer, not a scoring engine: for every prediction it (1) reads the raw DB columns needed, (2) posts them as raw features to `cash-gap-bank-ai-service` (never a DB id — see `cash-gap-bank-spec.md` section 7, since ai-service has no DB access of its own), and (3) returns the parsed response.

| Function | DB read | ai-service endpoint |
|---|---|---|
| `documentIntelligence(text, type)` | none (Node resolves `document_text`/`document_url` to text first) | `POST /predict/document-intelligence` |
| `timeToCash(store, invoiceId)` | `invoices` ⋈ `counterparties` | `POST /predict/time-to-cash` |
| `networkCredit(store, startupId, counterpartyId)` | `invoices` ⋈ `counterparties`, plus a COUNT of the startup's `recurring` counterparties | `POST /predict/network-credit` |
| `seedBridge(store, investmentCommitmentId)` | `investment_commitments` ⋈ `investors` ⋈ `startups` | `POST /predict/seed-bridge` |
| `recoveryOption(store, advanceId)` | `advances` ⋈ `cash_claims` ⋈ `startups`, plus SUM of unpaid `invoices.amount` and COUNT of `investment_commitments` | `POST /predict/recovery-option` |

`counterparties.network_centrality` is stored 0–100 in the DB but ai-service expects 0–1, so `timeToCash`/`networkCredit` divide it by 100 before sending.

### counterparty_tier classification

`networkCredit` must also send `counterparty_tier` (`large_corp`/`midsize`/`general`), which the DB does not store directly. `classifyCounterpartyTier(name)` in `engines/aiServiceClient.js` first checks a hardcoded map of the data repo's seed counterparty names (Samsung SDS / Hyundai AutoEver → `large_corp`; Seoul Mirae Hospital / Busan Green Clinic Network → `midsize`; everything else in the seed → `general`), then falls back to a keyword regex for any other name (conglomerate brand names → `large_corp`, hospital/clinic/medical/health → `midsize`, else `general`).

### Anthropic Document Intelligence

The LLM extraction itself now lives in `cash-gap-bank-ai-service` (`service/document_intelligence.py`), which uses Anthropic when `ANTHROPIC_API_KEY` is set on that service and otherwise falls back to a deterministic regex heuristic. This backend only resolves `document_text`/`document_url` to plain text before forwarding it.

### Running tests

- `npm test` runs the default suite, including `tests/aiServiceClient.test.js` (verifies the exact request bodies aiServiceClient sends, plus `counterparty_tier`/`active_recurring_contracts` logic) and `tests/api.test.js` (HTTP wiring). Both mock ai-service with an in-process HTTP stub, so no Python dependency is required.
- `npm run test:integration:ai` spawns the real trained ai-service (via its `.venv`) and re-validates the scenario end-to-end, including that all four `recovery_events` fixtures (A/B/C/D) still land on their intended waterfall option through the trained classifier.
- `npm run test:integration:pg` now also waits for the `ai-service` container from `docker-compose.yml` before running.
