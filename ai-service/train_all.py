"""Trains and saves all 4 models. Run: python train_all.py"""
import json
from models import time_to_cash, graph_risk, seed_bridge, recovery_policy


def main():
    print("=== Training time_to_cash ===")
    ttc_metrics = time_to_cash.train()
    print(json.dumps(ttc_metrics, indent=2))

    print("\n=== Training graph_risk ===")
    gr_metrics = graph_risk.train()
    print(json.dumps(gr_metrics, indent=2))

    print("\n=== Training seed_bridge ===")
    sb_metrics = seed_bridge.train()
    print(json.dumps(sb_metrics, indent=2))

    print("\n=== Training recovery_policy ===")
    rp_metrics = recovery_policy.train()
    print(json.dumps(rp_metrics, indent=2))

    print("\n=== Summary ===")
    print(json.dumps({
        "time_to_cash": ttc_metrics,
        "graph_risk": gr_metrics,
        "seed_bridge": sb_metrics,
        "recovery_policy": rp_metrics,
    }, indent=2))


if __name__ == "__main__":
    main()
