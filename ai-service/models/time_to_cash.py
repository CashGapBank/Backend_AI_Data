"""Time-to-Cash Engine: CoxPHFitter survival model over invoices.

Predicts probability of payment within 30/60/90 days and an expected
settlement day count, from invoice/counterparty features.
"""
import os
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
DATA_PATH = os.path.join(BASE_DIR, "data", "invoices.csv")
ARTIFACT_PATH = os.path.join(BASE_DIR, "models", "artifacts", "time_to_cash.joblib")

RELATIONSHIP_TYPES = ["poc", "contract", "recurring"]
FEATURE_COLUMNS = [
    "amount_log", "renewal_rate", "network_centrality", "historical_delay_days",
    "relationship_type_contract", "relationship_type_recurring",
]


def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    out["amount_log"] = np.log1p(df["amount"])
    out["renewal_rate"] = df["renewal_rate"]
    out["network_centrality"] = df["network_centrality"]
    out["historical_delay_days"] = df["historical_delay_days"]
    out["relationship_type_contract"] = (df["relationship_type"] == "contract").astype(int)
    out["relationship_type_recurring"] = (df["relationship_type"] == "recurring").astype(int)
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

    max_duration = float(df["duration"].max())

    os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
    joblib.dump({"model": cph, "max_duration": max_duration}, artifact_path)

    return {"model": "time_to_cash (CoxPHFitter)", "c_index": round(float(c_index), 4), "n_train": len(train_df), "n_test": len(test)}


def load(artifact_path: str = ARTIFACT_PATH) -> dict:
    return joblib.load(artifact_path)


def predict(artifact: dict, features: dict) -> dict:
    """features: amount, renewal_rate, network_centrality, historical_delay_days, relationship_type"""
    cph = artifact["model"]
    max_duration = artifact["max_duration"]

    row = pd.DataFrame([{
        "amount_log": np.log1p(features["amount"]),
        "renewal_rate": features["renewal_rate"],
        "network_centrality": features["network_centrality"],
        "historical_delay_days": features["historical_delay_days"],
        "relationship_type_contract": 1 if features["relationship_type"] == "contract" else 0,
        "relationship_type_recurring": 1 if features["relationship_type"] == "recurring" else 0,
    }])[FEATURE_COLUMNS]

    survival_fn = cph.predict_survival_function(row).iloc[:, 0]

    def prob_by(day: float) -> float:
        idx = survival_fn.index[survival_fn.index <= day]
        s = survival_fn.loc[idx[-1]] if len(idx) else 1.0
        return float(np.clip((1 - s) * 100, 0, 100))

    p30, p60, p90 = prob_by(30), prob_by(60), prob_by(90)

    median = _scalar(cph.predict_median(row))
    if not np.isfinite(median):
        expectation = _scalar(cph.predict_expectation(row))
        expected_settlement_days = expectation if np.isfinite(expectation) else max_duration
    else:
        expected_settlement_days = median
    expected_settlement_days = float(np.clip(expected_settlement_days, 1, max_duration * 1.5))

    payment_probability = prob_by(max_duration)

    return {
        "payment_probability": round(payment_probability, 1),
        "expected_settlement_days": round(expected_settlement_days),
        "p30": round(p30, 1),
        "p60": round(p60, 1),
        "p90": round(p90, 1),
    }


if __name__ == "__main__":
    print(train())
