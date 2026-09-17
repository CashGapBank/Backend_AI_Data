import os
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException

from models import time_to_cash, graph_risk, seed_bridge, recovery_policy
from service import document_intelligence
from service.schemas import (
    DocumentIntelligenceRequest, DocumentIntelligenceResponse,
    TimeToCashRequest, TimeToCashResponse,
    NetworkCreditRequest, NetworkCreditResponse,
    SeedBridgeRequest, SeedBridgeResponse,
    RecoveryOptionRequest, RecoveryOptionResponse,
)

load_dotenv()

ARTIFACTS: dict = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    ARTIFACTS["time_to_cash"] = time_to_cash.load()
    ARTIFACTS["graph_risk"] = graph_risk.load()
    ARTIFACTS["seed_bridge"] = seed_bridge.load()
    ARTIFACTS["recovery_policy"] = recovery_policy.load()
    yield
    ARTIFACTS.clear()


app = FastAPI(title="Cash Gap Bank AI Service", lifespan=lifespan)


@app.get("/health")
def health():
    return {"status": "ok", "models_loaded": list(ARTIFACTS.keys())}


@app.post("/predict/document-intelligence", response_model=DocumentIntelligenceResponse)
def predict_document_intelligence(req: DocumentIntelligenceRequest):
    result = document_intelligence.extract(req.document_text, req.document_type)
    return DocumentIntelligenceResponse(**result)


@app.post("/predict/time-to-cash", response_model=TimeToCashResponse)
def predict_time_to_cash(req: TimeToCashRequest):
    artifact = ARTIFACTS.get("time_to_cash")
    if artifact is None:
        raise HTTPException(status_code=503, detail="time_to_cash model not loaded")
    result = time_to_cash.predict(artifact, req.model_dump())
    return TimeToCashResponse(**result)


@app.post("/predict/network-credit", response_model=NetworkCreditResponse)
def predict_network_credit(req: NetworkCreditRequest):
    artifact = ARTIFACTS.get("graph_risk")
    if artifact is None:
        raise HTTPException(status_code=503, detail="graph_risk model not loaded")
    result = graph_risk.predict(artifact, req.model_dump())
    return NetworkCreditResponse(**result)


@app.post("/predict/seed-bridge", response_model=SeedBridgeResponse)
def predict_seed_bridge(req: SeedBridgeRequest):
    artifact = ARTIFACTS.get("seed_bridge")
    if artifact is None:
        raise HTTPException(status_code=503, detail="seed_bridge model not loaded")
    result = seed_bridge.predict(artifact, req.model_dump())
    return SeedBridgeResponse(**result)


@app.post("/predict/recovery-option", response_model=RecoveryOptionResponse)
def predict_recovery_option(req: RecoveryOptionRequest):
    artifact = ARTIFACTS.get("recovery_policy")
    if artifact is None:
        raise HTTPException(status_code=503, detail="recovery_policy model not loaded")
    result = recovery_policy.predict(artifact, req.model_dump())
    return RecoveryOptionResponse(**result)
