"""Document Intelligence: extracts structured fields from raw document text.

Uses an LLM (Claude) for structured extraction when ANTHROPIC_API_KEY is
configured; otherwise falls back to regex/keyword heuristics.
"""
import json
import os
import re
from datetime import datetime

FIELDS = [
    "amount", "counterparty", "payment_date", "expected_closing",
    "conditions_precedent", "termination_clause", "payment_term",
]

_SYSTEM_PROMPT = """You extract structured fields from startup financing / B2B commercial documents \
(term sheets, contracts, invoices). Given the document text and its type, return ONLY a JSON object \
with these keys (use null for anything not present in the text):
- amount: number (the principal / invoice / committed amount, numeric only, no currency symbols)
- counterparty: string (the investor name for term sheets, or the counterparty company name for contracts/invoices)
- payment_date: string in YYYY-MM-DD format (due date / payment date, mainly for invoices/contracts)
- expected_closing: string in YYYY-MM-DD format (expected closing date, mainly for term sheets)
- conditions_precedent: array of strings (conditions precedent clauses, mainly for term sheets)
- termination_clause: string (the termination clause text, mainly for contracts)
- payment_term: string (payment terms, e.g. "Net 30", mainly for invoices/contracts)

Return raw JSON only, no markdown fences, no commentary."""


def _try_llm_extract(document_text: str, document_type: str) -> dict | None:
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        return None
    try:
        import anthropic
        client = anthropic.Anthropic(api_key=api_key)
        message = client.messages.create(
            model="claude-sonnet-5",
            max_tokens=1024,
            system=_SYSTEM_PROMPT,
            messages=[{
                "role": "user",
                "content": f"document_type: {document_type}\n\ndocument text:\n{document_text}",
            }],
        )
        text = "".join(block.text for block in message.content if hasattr(block, "text"))
        text = text.strip()
        if text.startswith("```"):
            text = re.sub(r"^```(json)?", "", text).rstrip("`").strip()
        data = json.loads(text)
        return {field: data.get(field) for field in FIELDS}
    except Exception:
        return None


_AMOUNT_RE = re.compile(
    r"(?:amount|금액|principal|invoice total|committed amount)\s*[:\-]?\s*[₩$]?\s*([\d,]+(?:\.\d+)?)",
    re.IGNORECASE,
)
_FALLBACK_AMOUNT_RE = re.compile(r"[₩$]\s*([\d,]{4,}(?:\.\d+)?)")
_DATE_RE = re.compile(r"(\d{4}-\d{2}-\d{2})")
_COUNTERPARTY_RE = re.compile(
    r"(?:counterparty|investor|company|client|vendor|between)\s*[:\-]?\s*([A-Za-z가-힣0-9&.,\s]{2,60}?)(?:\n|,|\.|$)",
    re.IGNORECASE,
)
_PAYMENT_TERM_RE = re.compile(r"(net\s*\d+|payment term[s]?\s*[:\-]?\s*[^\n.]{2,40})", re.IGNORECASE)
_TERMINATION_RE = re.compile(r"([^\n.]*terminat[^\n.]*\.)", re.IGNORECASE)
_CONDITION_LINE_RE = re.compile(r"(?:^|\n)\s*(?:[-*•]|\(?\d+[.)])\s*([^\n]{3,200})")


def _heuristic_extract(document_text: str, document_type: str) -> dict:
    text = document_text

    amount = None
    m = _AMOUNT_RE.search(text) or _FALLBACK_AMOUNT_RE.search(text)
    if m:
        try:
            amount = float(m.group(1).replace(",", ""))
        except ValueError:
            amount = None

    counterparty = None
    m = _COUNTERPARTY_RE.search(text)
    if m:
        counterparty = m.group(1).strip()

    dates = _DATE_RE.findall(text)
    payment_date = dates[0] if dates else None
    expected_closing = None
    if document_type == "term_sheet":
        expected_closing = dates[0] if dates else None
        payment_date = None
    elif len(dates) > 1:
        expected_closing = dates[1]

    payment_term = None
    m = _PAYMENT_TERM_RE.search(text)
    if m:
        payment_term = m.group(1).strip()

    termination_clause = None
    m = _TERMINATION_RE.search(text)
    if m:
        termination_clause = m.group(1).strip()

    conditions_precedent = []
    if "condition" in text.lower() or "선행조건" in text:
        for line_match in _CONDITION_LINE_RE.finditer(text):
            line = line_match.group(1).strip()
            if line and line not in conditions_precedent:
                conditions_precedent.append(line)
            if len(conditions_precedent) >= 10:
                break

    return {
        "amount": amount,
        "counterparty": counterparty,
        "payment_date": payment_date,
        "expected_closing": expected_closing,
        "conditions_precedent": conditions_precedent,
        "termination_clause": termination_clause,
        "payment_term": payment_term,
    }


def extract(document_text: str, document_type: str) -> dict:
    result = _try_llm_extract(document_text, document_type)
    if result is not None:
        return result
    return _heuristic_extract(document_text, document_type)
