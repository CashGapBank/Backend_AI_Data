from typing import Literal, Optional
from pydantic import BaseModel, Field


# ---- Document Intelligence -------------------------------------------------
class DocumentIntelligenceRequest(BaseModel):
    document_text: str
    document_type: Literal["term_sheet", "contract", "invoice"]


class DocumentIntelligenceResponse(BaseModel):
    amount: Optional[float] = None
    counterparty: Optional[str] = None
    payment_date: Optional[str] = None
    expected_closing: Optional[str] = None
    conditions_precedent: list[str] = Field(default_factory=list)
    termination_clause: Optional[str] = None
    payment_term: Optional[str] = None


# ---- Time-to-Cash -----------------------------------------------------------
class TimeToCashRequest(BaseModel):
    amount: float
    renewal_rate: float = Field(ge=0, le=100)
    network_centrality: float = Field(ge=0, le=1)
    relationship_type: Literal["poc", "contract", "recurring"]
    historical_delay_days: float = Field(ge=0)


class TimeToCashResponse(BaseModel):
    payment_probability: float
    expected_settlement_days: int
    p30: float
    p60: float
    p90: float


# ---- Network Credit ----------------------------------------------------------
class NetworkCreditRequest(BaseModel):
    amount: Optional[float] = 10_000_000
    renewal_rate: float = Field(ge=0, le=100)
    network_centrality: float = Field(ge=0, le=1)
    relationship_type: Literal["poc", "contract", "recurring"]
    historical_delay_days: float = Field(ge=0)
    active_recurring_contracts: int = Field(ge=0, default=0)
    counterparty_tier: Literal["general", "midsize", "large_corp"] = "general"


class NetworkCreditResponse(BaseModel):
    network_credit_score: float
    counterparty_risk: Literal["low", "medium", "high"]


# ---- Seed Bridge --------------------------------------------------------------
class SeedBridgeRequest(BaseModel):
    committed_amount: float
    expected_closing_date: str
    investor_track_record_score: float = Field(ge=0, le=100)
    status: Literal["term_sheet_signed", "due_diligence_completed", "board_approved", "funds_wired", "revoked"]
    runway_months: float = Field(ge=0)


class SeedBridgeFactors(BaseModel):
    investor_trust: float
    diligence_stage: float
    runway: float
    closing_proximity: float


class SeedBridgeResponse(BaseModel):
    seed_bridge_score: float
    funding_probability: float
    expected_closing: str
    recommended_advance_capacity: float
    factors: SeedBridgeFactors


# ---- Recovery Option ------------------------------------------------------------
class RecoveryOptionRequest(BaseModel):
    outstanding_bridge: float
    current_cash: float
    verified_receivables: float
    monthly_burn: float
    runway_months: float = Field(ge=0)
    past_investment_count: int = Field(ge=0)


class RecoveryOptionResponse(BaseModel):
    recommended_option: Literal["A", "B", "C", "D"]
    confidence: float
    class_probabilities: dict[str, float]
