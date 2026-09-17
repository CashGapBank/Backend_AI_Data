CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE startup_stage AS ENUM ('seed', 'growth');
CREATE TYPE commitment_status AS ENUM ('term_sheet_signed', 'due_diligence_completed', 'board_approved', 'funds_wired', 'revoked');
CREATE TYPE relationship_type AS ENUM ('poc', 'contract', 'recurring');
CREATE TYPE source_type AS ENUM ('investment_commitment', 'invoice');
CREATE TYPE counterparty_risk AS ENUM ('low', 'medium', 'high');
CREATE TYPE duplicate_financing AS ENUM ('none', 'flagged');
CREATE TYPE advance_status AS ENUM ('active', 'repaid', 'in_recovery');
CREATE TYPE recovery_option AS ENUM ('A_collateral_swap', 'B_installment', 'C_investor_match', 'D_partial_restructure');

CREATE TABLE startups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  stage startup_stage NOT NULL,
  monthly_burn NUMERIC NOT NULL,
  current_cash NUMERIC NOT NULL,
  runway_months NUMERIC NOT NULL
);

CREATE TABLE investors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  track_record_score NUMERIC NOT NULL CHECK (track_record_score BETWEEN 0 AND 100)
);

CREATE TABLE investment_commitments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  startup_id UUID NOT NULL REFERENCES startups(id),
  investor_id UUID NOT NULL REFERENCES investors(id),
  committed_amount NUMERIC NOT NULL,
  expected_closing_date DATE NOT NULL,
  status commitment_status NOT NULL,
  credential_id TEXT NOT NULL UNIQUE
);

CREATE TABLE counterparties (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  startup_id UUID NOT NULL REFERENCES startups(id),
  name TEXT NOT NULL,
  relationship_type relationship_type NOT NULL,
  renewal_rate NUMERIC NOT NULL CHECK (renewal_rate BETWEEN 0 AND 100),
  network_centrality NUMERIC NOT NULL DEFAULT 0 CHECK (network_centrality BETWEEN 0 AND 100)
);

CREATE TABLE invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  startup_id UUID NOT NULL REFERENCES startups(id),
  counterparty_id UUID NOT NULL REFERENCES counterparties(id),
  amount NUMERIC NOT NULL,
  due_date DATE NOT NULL,
  paid_date DATE,
  historical_delay_days NUMERIC NOT NULL DEFAULT 0
);

CREATE TABLE cash_claims (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  startup_id UUID NOT NULL REFERENCES startups(id),
  source_type source_type NOT NULL,
  source_id UUID NOT NULL,
  verified_on_chain BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE ai_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_claim_id UUID NOT NULL REFERENCES cash_claims(id),
  payment_probability NUMERIC NOT NULL CHECK (payment_probability BETWEEN 0 AND 100),
  expected_settlement_days NUMERIC NOT NULL,
  counterparty_risk counterparty_risk NOT NULL,
  duplicate_financing duplicate_financing NOT NULL,
  seed_bridge_score NUMERIC CHECK (seed_bridge_score BETWEEN 0 AND 100),
  network_credit_score NUMERIC CHECK (network_credit_score BETWEEN 0 AND 100),
  computed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE advances (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_claim_id UUID NOT NULL REFERENCES cash_claims(id),
  advance_amount NUMERIC NOT NULL,
  status advance_status NOT NULL DEFAULT 'active'
);

CREATE TABLE recovery_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  advance_id UUID NOT NULL REFERENCES advances(id),
  triggered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  snapshot_outstanding_bridge NUMERIC NOT NULL,
  snapshot_current_cash NUMERIC NOT NULL,
  snapshot_verified_receivables NUMERIC NOT NULL,
  snapshot_monthly_burn NUMERIC NOT NULL,
  snapshot_runway_months NUMERIC NOT NULL,
  recommended_option recovery_option NOT NULL
);
