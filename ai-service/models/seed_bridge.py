"""Seed Bridge Score Engine.

Trains a CoxPHFitter survival model over investment_commitments to predict
funding_probability / expected_closing, and combines it with the spec 3-1
deterministic Seed Bridge Score formula (kept identical to the Node backend's
scoring engine) to produce recommended_advance_capacity.
"""
import os
from datetime import date, timedelta
import numpy as np
import pandas as pd
import joblib
from lifelines import CoxPHFitter
from lifelines.utils import concordance_index


def _scalar(value):
    """lifelines predict_median/predict_expectation may return a Series or a bare scalar."""
    if isinstance(value, pd.Series):
        return float(value.iloc[0])
    return float(value)

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(BASE_DIR, "data", "investment_commitments.csv")
ARTIFACT_PATH = os.path.join(BASE_DIR, "models", "artifacts", "seed_bridge.joblib")

STATUSES = ["term_sheet_signed", "due_diligence_completed", "board_approved", "revoked"]
STAGE_SCORE = {
    "term_sheet_signed": 40,
    "due_diligence_completed": 70,
    "board_approved": 90,
    "funds_wired": 100,
    "revoked": 0,
}
FEATURE_COLUMNS = [
    "committed_amount_log", "investor_track_record_score",
    "status_due_diligence_completed", "status_board_approved", "status_revoked",
]


def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    out["committed_amount_log"] = np.log1p(df["committed_amount"])
    out["investor_track_record_score"] = df["investor_track_record_score"]
    out["status_due_diligence_completed"] = (df["status"] == "due_diligence_completed").astype(int)
    out["status_board_approved"] = (df["status"] == "board_approved").astype(int)
    out["status_revoked"] = (df["status"] == "revoked").astype(int)
    return out[FEATURE_COLUMNS]


def train(data_path: str = DATA_PATH, artifact_path: str = ARTIFACT_PATH) -> dict:
    df = pd.read_csv(data_path)
    X = _build_features(df)
    X["duration"] = df["duration"].clip(lower=0.5)
    X["event"] = df["event"]

    n_test = max(1, int(len(X) * 0.2))
    test = X.sample(n=n_test, random_state=42)
    train_df = X.drop(test.index)

    cph = CoxPHFitter(penalizer=0.1)
    cph.fit(train_df, duration_col="duration", event_col="event")

    test_partial_hazard = cph.predict_partial_hazard(test[FEATURE_COLUMNS])
    c_index = concordance_index(test["duration"], -test_partial_hazard, test["event"])

    os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
    joblib.dump({"model": cph}, artifact_path)

    return {"model": "seed_bridge (CoxPHFitter)", "c_index": round(float(c_index), 4), "n_train": len(train_df), "n_test": len(test)}


def load(artifact_path: str = ARTIFACT_PATH) -> dict:
    return joblib.load(artifact_path)


def _clamp(value, lo=0, hi=100):
    return max(lo, min(hi, value))


def _seed_bridge_score(investor_track_record_score, status, runway_months, days_until_closing):
    investor_trust = _clamp(investor_track_record_score)
    diligence_stage = STAGE_SCORE.get(status, 0)
    runway = _clamp((runway_months / 6) * 100)
    closing_proximity = _clamp(100 - days_until_closing * 0.5)
    score = investor_trust * 0.35 + diligence_stage * 0.25 + runway * 0.20 + closing_proximity * 0.20
    return round(score), {
        "investor_trust": round(investor_trust),
        "diligence_stage": round(diligence_stage),
        "runway": round(runway),
        "closing_proximity": round(closing_proximity),
    }


def predict(artifact: dict, features: dict, reference_date: date = None) -> dict:
    """features: committed_amount, expected_closing_date (ISO str), investor_track_record_score,
    status, runway_months"""
    cph = artifact["model"]
    reference_date = reference_date or date.today()

    row = pd.DataFrame([{
        "committed_amount_log": np.log1p(features["committed_amount"]),
        "investor_track_record_score": features["investor_track_record_score"],
        "status_due_diligence_completed": 1 if features["status"] == "due_diligence_completed" else 0,
        "status_board_approved": 1 if features["status"] == "board_approved" else 0,
        "status_revoked": 1 if features["status"] == "revoked" else 0,
    }])[FEATURE_COLUMNS]

    expected_closing_date = date.fromisoformat(features["expected_closing_date"])
    days_until_closing = max(0, (expected_closing_date - reference_date).days)

    survival_fn = cph.predict_survival_function(row).iloc[:, 0]
    idx = survival_fn.index[survival_fn.index <= max(days_until_closing, 1)]
    s_at_horizon = survival_fn.loc[idx[-1]] if len(idx) else 1.0
    funding_probability = float(np.clip((1 - s_at_horizon) * 100, 1, 99))

    median = _scalar(cph.predict_median(row))
    if not np.isfinite(median):
        expectation = _scalar(cph.predict_expectation(row))
        predicted_duration = expectation if np.isfinite(expectation) else days_until_closing
    else:
        predicted_duration = median
    expected_closing = (reference_date + timedelta(days=round(predicted_duration))).isoformat()

    seed_bridge_score, factors = _seed_bridge_score(
        features["investor_track_record_score"], features["status"],
        features["runway_months"], days_until_closing,
    )

    risk_adjustment = (funding_probability / 100) * (seed_bridge_score / 100)
    recommended_advance_capacity = round(features["committed_amount"] * risk_adjustment, 2)

    return {
        "seed_bridge_score": seed_bridge_score,
        "funding_probability": round(funding_probability, 1),
        "expected_closing": expected_closing,
        "recommended_advance_capacity": recommended_advance_capacity,
        "factors": factors,
    }


if __name__ == "__main__":
    print(train())
