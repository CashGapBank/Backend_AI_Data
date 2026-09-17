"""Synthetic data generator for Cash Gap Bank AI service.

Produces three CSVs under data/:
  - investment_commitments.csv  (Seed Bridge)
  - invoices.csv                (Time-to-Cash / Network Credit)
  - recovery_snapshots.csv      (Recovery Policy waterfall)

Run: python data/synth_gen.py
"""
import os
import uuid
import numpy as np
import pandas as pd
from faker import Faker

fake = Faker()
Faker.seed(42)
rng = np.random.default_rng(42)

OUT_DIR = os.path.dirname(os.path.abspath(__file__))

N_COMMITMENTS = 3000
N_INVOICES = 4000
N_RECOVERY = 2000

STATUSES = ["term_sheet_signed", "due_diligence_completed", "board_approved", "revoked"]
STATUS_BASE_PROB = {  # baseline probability of eventually funding, before investor-trust adjustment
    "term_sheet_signed": 0.35,
    "due_diligence_completed": 0.60,
    "board_approved": 0.85,
    "revoked": 0.02,
}
STATUS_BASE_DURATION = {  # baseline days-to-close, before investor-trust adjustment
    "term_sheet_signed": 75,
    "due_diligence_completed": 45,
    "board_approved": 20,
    "revoked": 200,
}

RELATIONSHIP_TYPES = ["poc", "contract", "recurring"]


def gen_investment_commitments(n=N_COMMITMENTS):
    rows = []
    for _ in range(n):
        status = rng.choice(STATUSES, p=[0.35, 0.30, 0.25, 0.10])
        track_record = float(np.clip(rng.normal(60, 20), 0, 100))
        committed_amount = float(np.clip(rng.lognormal(mean=17.5, sigma=0.6), 5_000_000, 2_000_000_000))

        trust_factor = track_record / 100.0
        base_prob = STATUS_BASE_PROB[status]
        # higher investor trust materially raises funding probability
        funding_prob = np.clip(base_prob * (0.5 + trust_factor), 0.01, 0.98)
        event = int(rng.random() < funding_prob)

        base_duration = STATUS_BASE_DURATION[status]
        # higher trust -> faster close; add noise for boundary generalization
        duration = base_duration * (1.3 - 0.6 * trust_factor)
        duration = float(np.clip(rng.normal(duration, duration * 0.25), 3, 400))

        expected_closing_date = fake.date_between(start_date="-30d", end_date="+180d")

        rows.append({
            "id": str(uuid.uuid4()),
            "committed_amount": round(committed_amount, 2),
            "expected_closing_date": expected_closing_date.isoformat(),
            "investor_track_record_score": round(track_record, 1),
            "status": status,
            "event": event,
            "duration": round(duration, 1),
        })
    return pd.DataFrame(rows)


def gen_invoices(n=N_INVOICES):
    rows = []
    for _ in range(n):
        relationship_type = rng.choice(RELATIONSHIP_TYPES, p=[0.35, 0.40, 0.25])
        renewal_rate = float(np.clip(rng.normal(
            {"poc": 40, "contract": 65, "recurring": 85}[relationship_type], 15), 0, 100))
        network_centrality = float(np.clip(rng.beta(2, 5) + (0.15 if relationship_type == "recurring" else 0), 0, 1))
        historical_delay_days = float(np.clip(rng.normal(
            {"poc": 20, "contract": 12, "recurring": 4}[relationship_type], 8), 0, 90))
        amount = float(np.clip(rng.lognormal(mean=15.5, sigma=0.7), 500_000, 300_000_000))

        # higher renewal_rate / centrality / lower historical delay -> pays faster & fully
        quality = (renewal_rate / 100) * 0.5 + network_centrality * 0.3 + (1 - historical_delay_days / 90) * 0.2
        event_prob = np.clip(0.4 + quality * 0.55, 0.05, 0.98)
        event = int(rng.random() < event_prob)

        base_duration = 45 - quality * 30
        duration = float(np.clip(rng.normal(base_duration, 10), 1, 180))

        rows.append({
            "id": str(uuid.uuid4()),
            "amount": round(amount, 2),
            "renewal_rate": round(renewal_rate, 1),
            "network_centrality": round(network_centrality, 3),
            "relationship_type": relationship_type,
            "historical_delay_days": round(historical_delay_days, 1),
            "duration": round(duration, 1),
            "event": event,
        })
    return pd.DataFrame(rows)


def waterfall_option(outstanding_bridge, verified_receivables, runway_months, past_investment_count):
    if verified_receivables >= outstanding_bridge * 1.5:
        return "A"
    if runway_months >= 4:
        return "B"
    if runway_months < 2 and past_investment_count >= 2:
        return "C"
    return "D"


def gen_recovery_snapshots(n=N_RECOVERY):
    rows = []
    for _ in range(n):
        outstanding_bridge = float(np.clip(rng.lognormal(mean=17, sigma=0.6), 5_000_000, 1_000_000_000))
        current_cash = float(np.clip(rng.lognormal(mean=16, sigma=0.8), 1_000_000, 500_000_000))
        # verified_receivables spread wide relative to outstanding_bridge so all branches get hit
        receivable_ratio = rng.uniform(0.2, 2.2)
        verified_receivables = float(outstanding_bridge * receivable_ratio)
        monthly_burn = float(np.clip(rng.lognormal(mean=15.5, sigma=0.5), 1_000_000, 100_000_000))
        runway_months = float(np.clip(current_cash / max(monthly_burn, 1), 0, 24))
        past_investment_count = int(rng.poisson(1.3))

        # small feature jitter so decision boundaries aren't perfectly crisp
        noisy_outstanding = outstanding_bridge * float(rng.normal(1.0, 0.03))
        noisy_receivables = verified_receivables * float(rng.normal(1.0, 0.03))
        noisy_runway = max(0.0, runway_months * float(rng.normal(1.0, 0.05)))

        label = waterfall_option(noisy_outstanding, noisy_receivables, noisy_runway, past_investment_count)

        # inject ~3% label noise for realistic generalization at boundaries
        if rng.random() < 0.03:
            label = rng.choice(["A", "B", "C", "D"])

        rows.append({
            "id": str(uuid.uuid4()),
            "outstanding_bridge": round(outstanding_bridge, 2),
            "current_cash": round(current_cash, 2),
            "verified_receivables": round(verified_receivables, 2),
            "monthly_burn": round(monthly_burn, 2),
            "runway_months": round(runway_months, 2),
            "past_investment_count": past_investment_count,
            "recommended_option": label,
        })
    return pd.DataFrame(rows)


def main():
    commitments = gen_investment_commitments()
    invoices = gen_invoices()
    recovery = gen_recovery_snapshots()

    commitments.to_csv(os.path.join(OUT_DIR, "investment_commitments.csv"), index=False)
    invoices.to_csv(os.path.join(OUT_DIR, "invoices.csv"), index=False)
    recovery.to_csv(os.path.join(OUT_DIR, "recovery_snapshots.csv"), index=False)

    print(f"investment_commitments: {len(commitments)} rows -> investment_commitments.csv")
    print(f"invoices:               {len(invoices)} rows -> invoices.csv")
    print(f"recovery_snapshots:     {len(recovery)} rows -> recovery_snapshots.csv")
    print("\nrecovery_snapshots label distribution:")
    print(recovery["recommended_option"].value_counts())


if __name__ == "__main__":
    main()
