# Cash Gap Bank Seed Data

This repository contains reusable hackathon seed data for the Cash Gap Bank data layer.

- SQL seed script: `seed/sql/001_cash_gap_bank_seed.sql`
- JSON fixture: `seed/json/cash_gap_bank_seed.json`
- Source spec: `../cash-gap-bank-spec.md` from this data directory.

The SQL file inserts rows for the section 1 database schema: `startups`, `investors`, `investment_commitments`, `counterparties`, `invoices`, `cash_claims`, `ai_scores`, `advances`, and `recovery_events`. It first deletes the deterministic demo row IDs, so it can be re-run in a local PostgreSQL demo database without duplicate-key failures.

The JSON fixture mirrors the same row identifiers and values, then adds demo metadata that the schema does not directly store, such as term sheet conditions, counterparty contract periods, and payment history notes.

## Scenario A: Seed Bridge

Startup A is `LumaLedger AI`, a seed-stage AI finance automation startup.

Financial state:

- Monthly burn: KRW 85,000,000
- Current cash: KRW 212,500,000
- Runway: 2.5 months

Seed Bridge cases:

- Normal case: `Han River Ventures` commitment of KRW 600,000,000, status `board_approved`, expected closing `2026-10-05`, Seed Bridge Score `81`.
- Supporting case: `Pioneer Seed Partners` commitment of KRW 350,000,000, status `due_diligence_completed`, expected closing `2026-10-20`.
- Risk case: `Blue Pine Angels` commitment of KRW 250,000,000, status `term_sheet_signed`, expected closing `2026-11-10`, Seed Bridge Score `54`.

The risk case is intentionally weaker because it has a lower investor track record, earlier diligence stage, and longer closing proximity. In the JSON fixture, its term sheet notes include security audit, pilot conversion, and lead allocation conditions to simulate possible diligence-stage dropout.

## Scenario B: Supply Credit

Startup B is `CareLink Ops`, a growth-stage healthcare operations startup with B2B receivables.

Counterparty mix:

- Large conglomerate affiliate PoC: `Samsung SDS AI Transformation PoC Team`
- Large conglomerate affiliate contract: `Hyundai AutoEver Connected Services Lab`
- Hospital recurring contract: `Seoul Mirae Hospital`
- Hospital and clinic recurring contract: `Busan Green Clinic Network`
- General mid-market counterparty: `Daejeon Retail Logistics Co.`
- General small-business recurring counterparty: `Mapo Food Service Cooperative`

The fixture includes renewal rates, network centrality, invoice amounts, due dates, payment dates, and historical delay days. JSON metadata also includes contract periods and payment history notes for AI/backend demos.

Important validation rows:

- Strong invoice claim: Samsung SDS invoice `d1111111-1111-4111-8111-111111111111`, Network Credit Score `83`, duplicate financing `none`.
- Strong invoice claim: Hyundai AutoEver invoice `d2222222-2222-4222-8222-222222222222`, Network Credit Score `85`, duplicate financing `none`.
- Blockchain risk test: Mapo Food Service invoice `d6666666-6666-4666-8666-666666666666`, Network Credit Score `59`, `verified_on_chain = false`, duplicate financing `flagged`.

## Future Cash Registry: chain_status Distribution

Each `cash_claims` row now carries the spec section 1 Future Cash Registry fields (`issuer`, `document_hash`, `chain_status`, `financing_status`). The 7 seed claims cover all five `chain_status` values at least once:

| Claim ID | Issuer | source_type | chain_status | financing_status | Notes |
|---|---|---|---|---|---|
| `e1111111-1111-4111-8111-111111111111` | Han River Ventures | investment_commitment | `FINANCED` | `FINANCED` | Duplicate-financing test candidate — already has two advances (`a1111111` active, `a5555555` in_recovery) against the same claim. Use this claim to exercise duplicate-financing detection logic. |
| `e2222222-2222-4222-8222-222222222222` | Blue Pine Angels | investment_commitment | `VERIFIED` | `NOT_FINANCED` | Seed Bridge risk case; verified on chain but not yet financed. |
| `e3333333-3333-4333-8333-333333333333` | Samsung SDS AI Transformation PoC Team | invoice | `SETTLED` | `FINANCED` | Fully resolved on the registry after financing. |
| `e4444444-4444-4444-8444-444444444444` | Hyundai AutoEver Connected Services Lab | invoice | `REVOKED` | `FINANCED` | Backs recovery event `r2222222-...` (`B_installment`) via advance `a4444444-...`. |
| `e5555555-5555-4555-8555-555555555555` | Mapo Food Service Cooperative | invoice | `REGISTERED` | `NOT_FINANCED` | `verified_on_chain = false`; not yet financed. Existing blockchain-risk test row. |
| `e6666666-6666-4666-8666-666666666666` | Recovery Verified Receivables Pool | invoice | `REVOKED` | `FINANCED` | Backs recovery event `r1111111-...` (`A_collateral_swap`) via advance `a2222222-...`. |
| `e7777777-7777-4777-8777-777777777777` | BridgeWorks Capital | investment_commitment | `REVOKED` | `FINANCED` | Backs recovery event `r4444444-...` (`D_partial_restructure`) via advance `a6666666-...`. |

Distribution: `REGISTERED` x1, `VERIFIED` x1, `FINANCED` x1, `REVOKED` x3, `SETTLED` x1.

Every `REVOKED` claim is one of the claims that backs a `recovery_events` row, so the revocation state stays consistent with the recovery waterfall scenarios below. The claim backing recovery event `r3333333-...` (`C_investor_match`, advance `a5555555-...`) is `e1111111-...`, which is currently `FINANCED` rather than `REVOKED` — it represents a claim that already carries a second, still-active advance (`a1111111-...`) alongside the one that was revoked and routed into recovery, i.e. the duplicate-financing test candidate noted above.

`document_hash` values are arbitrary placeholder hex strings (`sha256:...`) standing in for Document Intelligence's real hash of the source document; they are not computed from actual file contents.

## Recovery Waterfall Tests

The four `recovery_events` are designed so each waterfall branch from spec section 3 triggers exactly once.

| Event | Expected Option | Why It Triggers |
|---|---|---|
| `r1111111-1111-4111-8111-111111111111` | `A_collateral_swap` | Verified receivables KRW 160,000,000 >= outstanding bridge KRW 100,000,000 x 1.5 |
| `r2222222-2222-4222-8222-222222222222` | `B_installment` | A fails because KRW 100,000,000 < KRW 180,000,000; runway is 4.5 months |
| `r3333333-3333-4333-8333-333333333333` | `C_investor_match` | A and B fail; runway is 1.2 months and Startup A has 3 investment commitments |
| `r4444444-4444-4444-8444-444444444444` | `D_partial_restructure` | A and B fail; runway is 2.5 months, so C also fails because runway is not below 2 |

These values intentionally avoid threshold ambiguity so the demo can show deterministic waterfall behavior.

## Suggested Commit

When you create the git repository, a suitable Conventional Commits message is:

```text
feat: add cash gap bank seed data
```
