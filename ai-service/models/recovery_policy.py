"""Recovery Policy Engine.

Trains a GradientBoostingClassifier on recovery_snapshots.csv to classify
which of the 4 waterfall options (A/B/C/D, spec section 3) applies, and
reports how well it reproduces the deterministic rule.
"""
import os
import numpy as np
import pandas as pd
import joblib
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.model_selection import train_test_split
from sklearn.metrics import accuracy_score, f1_score

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_PATH = os.path.join(BASE_DIR, "data", "recovery_snapshots.csv")
ARTIFACT_PATH = os.path.join(BASE_DIR, "models", "artifacts", "recovery_policy.joblib")

CLASSES = ["A", "B", "C", "D"]
FEATURE_COLUMNS = [
    "outstanding_bridge_log", "current_cash_log", "verified_receivables_log",
    "monthly_burn_log", "runway_months", "past_investment_count",
    "receivables_to_bridge_ratio",
]


def _build_features(df: pd.DataFrame) -> pd.DataFrame:
    out = pd.DataFrame(index=df.index)
    out["outstanding_bridge_log"] = np.log1p(df["outstanding_bridge"])
    out["current_cash_log"] = np.log1p(df["current_cash"])
    out["verified_receivables_log"] = np.log1p(df["verified_receivables"])
    out["monthly_burn_log"] = np.log1p(df["monthly_burn"])
    out["runway_months"] = df["runway_months"]
    out["past_investment_count"] = df["past_investment_count"]
    out["receivables_to_bridge_ratio"] = df["verified_receivables"] / df["outstanding_bridge"].clip(lower=1)
    return out[FEATURE_COLUMNS]


def train(data_path: str = DATA_PATH, artifact_path: str = ARTIFACT_PATH) -> dict:
    df = pd.read_csv(data_path)
    X = _build_features(df)
    y = df["recommended_option"]

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y
    )

    clf = GradientBoostingClassifier(random_state=42)
    clf.fit(X_train, y_train)
    pred = clf.predict(X_test)

    accuracy = accuracy_score(y_test, pred)
    f1 = f1_score(y_test, pred, average="macro")

    os.makedirs(os.path.dirname(artifact_path), exist_ok=True)
    joblib.dump({"classifier": clf}, artifact_path)

    return {
        "model": "recovery_policy (GradientBoostingClassifier)",
        "accuracy": round(float(accuracy), 4),
        "f1_macro": round(float(f1), 4),
        "n_train": len(X_train),
        "n_test": len(X_test),
        "waterfall_reproduction_accuracy": round(float(accuracy), 4),
    }


def load(artifact_path: str = ARTIFACT_PATH) -> dict:
    return joblib.load(artifact_path)


def predict(artifact: dict, features: dict) -> dict:
    """features: outstanding_bridge, current_cash, verified_receivables,
    monthly_burn, runway_months, past_investment_count"""
    row = pd.DataFrame([{
        "outstanding_bridge": features["outstanding_bridge"],
        "current_cash": features["current_cash"],
        "verified_receivables": features["verified_receivables"],
        "monthly_burn": features["monthly_burn"],
        "runway_months": features["runway_months"],
        "past_investment_count": features["past_investment_count"],
    }])
    X = _build_features(row)

    clf = artifact["classifier"]
    proba = clf.predict_proba(X)[0]
    class_probabilities = {cls: round(float(p), 4) for cls, p in zip(clf.classes_, proba)}
    recommended_option = clf.classes_[int(np.argmax(proba))]
    confidence = round(float(np.max(proba)), 4)

    return {
        "recommended_option": recommended_option,
        "confidence": confidence,
        "class_probabilities": class_probabilities,
    }


if __name__ == "__main__":
    print(train())
