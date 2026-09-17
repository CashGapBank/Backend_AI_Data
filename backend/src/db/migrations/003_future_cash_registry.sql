-- Future Cash Registry fields (cash-gap-bank-spec.md section 1 cash_claims /
-- section 6 정합성 조정): the submitted proposal's Claim ID/Issuer/Document
-- Hash/Status/Financing Status, plus the on-chain registry status model,
-- which is a separate layer from investment_commitments.status (deal
-- progress stage).
CREATE TYPE cash_claim_chain_status AS ENUM ('REGISTERED', 'VERIFIED', 'FINANCED', 'REVOKED', 'SETTLED');
CREATE TYPE cash_claim_financing_status AS ENUM ('NOT_FINANCED', 'FINANCED');

ALTER TABLE cash_claims
  ADD COLUMN issuer TEXT NOT NULL DEFAULT 'unknown',
  ADD COLUMN document_hash TEXT NOT NULL DEFAULT '',
  ADD COLUMN chain_status cash_claim_chain_status NOT NULL DEFAULT 'REGISTERED',
  ADD COLUMN financing_status cash_claim_financing_status NOT NULL DEFAULT 'NOT_FINANCED';

ALTER TABLE cash_claims ALTER COLUMN issuer DROP DEFAULT;
ALTER TABLE cash_claims ALTER COLUMN document_hash DROP DEFAULT;
