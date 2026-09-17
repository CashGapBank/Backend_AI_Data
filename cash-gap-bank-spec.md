# Cash Gap Bank — AI / Backend / Data 구현 스펙

담당: 눙 (AI, Backend, Data) / 친구 (프론트, 블록체인)

---

## 0. 구현 순서 추천

설계 우선, 코딩은 클로드 코드 CLI에 위임하는 구조이므로 순서는 "AI 코더가 산으로 안 가게 스키마와 계약을 먼저 확정"하는 것을 최우선으로 잡음.

| 단계 | 작업 | 이유 |
|---|---|---|
| Phase 0 | DB 스키마 확정 (본 문서 1절) | 이후 모든 AI 출력·API 응답이 이 스키마를 기준으로 설계됨. 가장 먼저 고정해야 함 |
| Phase 1 | Data — 시나리오 데이터셋 생성 (스타트업 A/B, 투자자, 거래처, revocation 스냅샷) | AI 엔진 개발/테스트에 바로 필요한 입력. 병렬로 진행 가능 |
| Phase 2 | AI — Document Intelligence | 다른 두 엔진(Graph Risk, Time-to-Cash)과 Credential 필드의 입력을 만들어내는 가장 앞단 |
| Phase 3 | AI — Graph Risk Engine | Document Intelligence 출력(계약/거래관계)을 그래프에 반영 |
| Phase 4 | AI — Time-to-Cash Engine | ①②의 출력을 받아 최종 확률/시점 예측 |
| Phase 5 | Backend — 개별 엔진 API 래핑 | ①②③을 각각 호출 가능한 API로 노출 |
| Phase 6 | Backend — 파이프라인 오케스트레이션 (Future Cash Claim 생성 → 검증 → 예측 → 한도산정 → 상환) | 3번 통합 파이프라인 전체를 잇는 단계. 이 시점에 친구의 블록체인 검증 API와 실제 연동 필요 |
| Phase 7 | AI+Backend — Recovery Policy Engine (Revocation 대응) | Phase 6 파이프라인이 있어야 "철회 이후 재라우팅"이 의미를 가짐 |
| Phase 8 (옵션) | Future Cash Graph (GNN 확장) | 난이도 최상. 위 단계가 안정화된 뒤 시간 보고 도전 |

친구 파트(Credential 발급/서명, Revocation 온체인 기록, 스마트컨트랙트 자동상환 트리거, 프론트 UI)는 Phase 2~4와 병렬로 진행하다가, Phase 6에서 웹훅 계약(4절)을 통해 실제로 맞물리는 구조로 잡는 걸 추천.

---

## 1. DB 스키마

### startups
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| name | string | |
| stage | enum(seed, growth) | Seed Bridge or Supply Credit 대상 구분용 |
| monthly_burn | number | 월 소진액 (원) |
| current_cash | number | 현재 보유 현금 |
| runway_months | number | 계산값 or 저장값 |

### investors
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| name | string | |
| track_record_score | number | 과거 투자 이력 기반 신뢰도 (0~100) |

### investment_commitments
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| startup_id | FK → startups | |
| investor_id | FK → investors | |
| committed_amount | number | |
| expected_closing_date | date | |
| status | enum(term_sheet_signed, due_diligence_completed, board_approved, funds_wired, revoked) | 5번 Credential Status와 동기화 |
| credential_id | string | 블록체인 측 Credential ID (친구 파트 참조키) |

### counterparties (B2B 거래처)
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| startup_id | FK → startups | |
| name | string | 예: 삼성 계열사, 병원 A |
| relationship_type | enum(poc, contract, recurring) | |
| renewal_rate | number | 갱신율 (%) |
| network_centrality | number | Graph Risk Engine 계산값 |

### invoices
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| startup_id | FK → startups | |
| counterparty_id | FK → counterparties | |
| amount | number | |
| due_date | date | |
| paid_date | date, nullable | |
| historical_delay_days | number | 과거 평균 지연일 |

### cash_claims (Future Cash Claim — 통합 개념, 3번 / 제출서류 "Future Cash Registry")
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | 제출서류의 Claim ID |
| startup_id | FK → startups | |
| source_type | enum(investment_commitment, invoice) | Seed Bridge / Supply Credit 구분 |
| source_id | UUID | investment_commitments.id or invoices.id |
| issuer | string | 제출서류 "Issuer" — 투자 건은 investor 이름, 매출채권 건은 counterparty 이름 |
| document_hash | string | 제출서류 "Document Hash" — Document Intelligence가 처리한 원본 문서 해시 |
| chain_status | enum(REGISTERED, VERIFIED, FINANCED, REVOKED, SETTLED) | 제출서류 2-3절의 Future Cash Registry 상태값. investment_commitments.status(딜 진행단계, 스코어링용)와는 별개 레이어 |
| financing_status | enum(NOT_FINANCED, FINANCED) | 동일 채권의 중복금융 탐지용 (chain_status=FINANCED와 연동) |
| verified_on_chain | boolean | 블록체인 이중담보 검증 결과 (친구 파트 응답 반영) |

### ai_scores (4번 다차원 지표 저장)
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| cash_claim_id | FK → cash_claims | |
| payment_probability | number (%) | Time-to-Cash Engine 출력 |
| expected_settlement_days | number | |
| counterparty_risk | enum(low, medium, high) | Graph Risk Engine 출력 |
| duplicate_financing | enum(none, flagged) | 블록체인 검증 결과 반영 |
| seed_bridge_score | number, nullable | source_type=investment_commitment일 때만 |
| network_credit_score | number, nullable | source_type=invoice일 때만 |
| computed_at | timestamp | |

### advances (은행이 실제 내준 금액)
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| cash_claim_id | FK → cash_claims | |
| advance_amount | number | Risk-adjusted Advance Limit 기준 실행액 |
| status | enum(active, repaid, in_recovery) | |

### recovery_events (6번 Revocation 이후)
| 필드 | 타입 | 설명 |
|---|---|---|
| id | UUID (PK) | |
| advance_id | FK → advances | |
| triggered_at | timestamp | |
| snapshot_outstanding_bridge | number | |
| snapshot_current_cash | number | |
| snapshot_verified_receivables | number | |
| snapshot_monthly_burn | number | |
| snapshot_runway_months | number | |
| recommended_option | enum(A_collateral_swap, B_installment, C_investor_match, D_partial_restructure) | |

---

## 2. API 명세

### Document Intelligence
`POST /api/document-intelligence/extract`
- Request: `{ "document_url": string, "document_type": "term_sheet" | "contract" | "invoice" }`
- Response: `{ "amount": number, "counterparty": string, "payment_date": date, "expected_closing": date, "conditions_precedent": string[], "termination_clause": string, "payment_term": string }`
  (제출서류 143행 기준 핵심 필드: amount/counterparty/payment_date/expected_closing/payment_term. expected_closing은 term_sheet에서 주로 채워짐)

**ai-service 실제 계약과의 차이**: ai-service `POST /predict/document-intelligence`는 `document_url`이 아니라 `document_text`(원문 텍스트)를 받음. Node는 문서를 먼저 텍스트로 확보(업로드된 파일 파싱 또는 저장된 원문 조회)한 뒤 `{ document_text, document_type }`로 ai-service를 호출할 것.

### Graph Risk Engine
`POST /api/graph/counterparty` — 거래관계 등록/갱신
- Request: `{ "startup_id": uuid, "counterparty_name": string, "relationship_type": string, "renewal_rate": number }`

`GET /api/scores/network-credit/{startup_id}`
- Response: `{ "network_credit_score": number, "counterparty_risk": "low"|"medium"|"high", "network_centrality": number }`

### Time-to-Cash Engine
`POST /api/predict/time-to-cash`
- Request: `{ "cash_claim_id": uuid }`
- Response: `{ "payment_probability": number, "expected_settlement_days": number, "p30": number, "p60": number, "p90": number }`

### Seed Bridge Score
`GET /api/scores/seed-bridge/{investment_commitment_id}`
- Response: `{ "seed_bridge_score": number, "funding_probability": number, "expected_closing": date, "recommended_advance_capacity": number, "factors": { "investor_trust": number, "diligence_stage": number, "runway": number } }`
  (제출서류 123행 기준 필수 산출값: Funding Probability, Expected Closing, Recommended Advance Capacity)

### Future Cash Claim (파이프라인 진입점)
`POST /api/cash-claims`
- Request: `{ "startup_id": uuid, "source_type": "investment_commitment"|"invoice", "source_id": uuid }`
- 내부 처리: Document Intelligence 결과 조회 → 친구 파트 블록체인 검증 API 호출(4절) → AI 점수 계산(위 엔드포인트들 순차 호출) → advance_limit 산정
- Response: `{ "cash_claim_id": uuid, "verified_on_chain": boolean, "ai_scores": {...}, "safe_advance_capacity": number }`

### Advance Limit 재계산 (Credential Status 변경 트리거)
`POST /api/advance-limit/recalculate`
- Request: `{ "investment_commitment_id": uuid, "new_status": string }`
- Response: `{ "new_advance_limit": number }`

### Recovery Policy Engine
`POST /api/recovery/analyze`
- Request: `{ "advance_id": uuid }` (Revocation 이벤트 수신 시 호출)
- Response: `{ "snapshot": {...}, "recommended_option": "A"|"B"|"C"|"D", "reasoning": string }`

---

## 3. Recovery Option 분기 규칙 (확정)

체크는 위에서 아래로 순차 평가 (waterfall) — 먼저 걸리는 조건 하나만 채택.

| 순서 | 조건 | 추천 옵션 |
|---|---|---|
| 1 | Verified Receivables ≥ Outstanding Bridge × 1.5 | A: B2B 매출채권으로 담보 전환 |
| 2 | Runway ≥ 4개월 (조건 1 미충족 시) | B: 6개월 분할상환 |
| 3 | Runway < 2개월 & 과거 투자 이력(investment_commitments 기록) 2건 이상 | C: 추가 투자자 매칭 |
| 4 | 위 어디에도 해당 없음 | D: 일부 상환 + 운전자금 재구조화 |

근거: 매출채권이 충분하면 담보 전환이 가장 빠르고 안전(옵션 A 최우선). Runway 여유 있으면 무리한 매칭 대신 분할상환으로 충분(B). Runway 급박하지만 투자 유치 이력이 있으면 신규 매칭 시도 가치 있음(C). 나머지는 재구조화로 시간 버는 것이 최선(D).

데모 시연 시 시나리오 데이터(Phase 1)를 이 4개 분기가 각각 한 번씩 걸리도록 설계하면 발표에서 로직 전체를 보여줄 수 있음.

---

## 3-1. 스코어링 공식 (확정)

### Seed Bridge Score (0~100)
| 요소 | 가중치 | 산출 방식 |
|---|---|---|
| Investor Trust | 35% | investors.track_record_score 그대로 사용 |
| Due Diligence Stage | 25% | term_sheet_signed=40, due_diligence_completed=70, board_approved=90, funds_wired=100 |
| Runway Coverage | 20% | min(100, runway_months / 6 × 100) — 6개월 이상이면 만점 |
| Closing Proximity | 20% | max(0, 100 − expected_closing까지 남은 일수 × 0.5) |

### Network Credit Score (0~100)
| 요소 | 가중치 | 산출 방식 |
|---|---|---|
| Counterparty Trust | 30% | 거래처 등급(대기업 계열사=90~100, 병원/중견=70~89, 일반=50~69) 평균 |
| Renewal Rate | 25% | counterparties.renewal_rate 그대로 사용 |
| Payment Reliability | 20% | max(0, 100 − historical_delay_days × 2) |
| Network Centrality | 15% | Graph Risk Engine 계산값 (0~100 정규화) |
| Active Recurring Contracts | 10% | min(100, 활성 반복계약 수 × 20) |

두 점수 모두 가중합 후 반올림. Time-to-Cash Engine의 Payment Probability는 이 두 점수와 별개로(4번 지표 자체가 산출) 유지 — 서로 다른 질문(신뢰도 vs 시점 확률)에 답하는 지표이므로 혼합하지 않음.

---

## 4. 블록체인 파트(친구)와의 연동 계약

Backend가 친구 쪽에 요청하는 것:
- `POST /chain/verify-claim` — Future Cash Claim 생성 시 이중담보 여부 검증 요청 → `{ "verified": boolean, "duplicate_financing": boolean }` 응답

친구 쪽이 Backend에 쏴주는 것 (웹훅):
- `POST /api/webhooks/credential-status-changed`
  - Body: `{ "investment_commitment_id": uuid, "new_status": string, "signed_by": string, "timestamp": datetime }`
  - Backend 동작: `investment_commitments.status` 갱신 → `/api/advance-limit/recalculate` 내부 호출
- `POST /api/webhooks/credential-revoked`
  - Body: `{ "investment_commitment_id": uuid, "revoked_by": string, "reason": string, "timestamp": datetime }`
  - Backend 동작: 해당 advance를 `in_recovery`로 변경 → `/api/recovery/analyze` 내부 호출 → 은행 알림 트리거

이 두 웹훅 스펙은 친구가 스마트컨트랙트/온체인 이벤트를 뭘로 emit하든 상관없이 고정된 인터페이스로 유지하는 게 좋음 — 친구 구현이 바뀌어도 Backend는 이 계약만 지키면 됨.

- `POST /api/webhooks/chain-status-changed` (신규 — 제출서류 Future Cash Registry 반영)
  - Body: `{ "cash_claim_id": uuid, "new_chain_status": "REGISTERED"|"VERIFIED"|"FINANCED"|"REVOKED"|"SETTLED", "timestamp": datetime }`
  - Backend 동작: `cash_claims.chain_status` 갱신. `FINANCED`로 바뀌면 `financing_status`도 `FINANCED`로 동기화 (중복금융 탐지 기준점). `REVOKED`로 바뀌면 기존 `credential-revoked` 웹훅과 동일하게 `/api/recovery/analyze` 트리거

투자 건(investment_commitments.status)과 매출채권 건 둘 다 이 `chain_status` 웹훅을 공통으로 받되, investment_commitments.status(딜 진행 단계)는 기존 `credential-status-changed` 웹훅으로 별도 관리 — 두 상태는 서로 다른 레이어(딜 진행 vs 블록체인 등록 상태)이므로 혼동하지 않도록 주의.

---

## 5. 기술 선택 확정 사항

- **Seed Bridge Score / Network Credit Score 가중치**: 3-1절 공식으로 확정
- **Recovery Option 분기 임계값**: 3절 waterfall 로직으로 확정
- **Document Intelligence**: 실제 LLM 파싱으로 구현 (고정 필드 매핑 아님). 시간 제약이 없고, 심사에서도 "AI가 실제로 문서를 읽는다"는 게 목업보다 설득력 있음. 프롬프트로 term sheet/invoice에서 JSON 필드 추출 → 추출 실패 시에만 수동 보정 폴백
- **Time-to-Cash Engine**: 정식 Cox 회귀 대신 경량 생존분석(Kaplan-Meier 기반 + 지수 위험함수 근사) 채택. 이유: Phase 1에서 만들 시나리오 데이터 규모가 크지 않아 Cox 회귀는 과적합 위험이 크고, 경량 모델로도 P(30/60/90일) 곡선을 실데이터 기반으로 뽑아낼 수 있어 "규칙 기반"보다는 실질적임
- **Future Cash Graph (Phase 8)**: 도전 대상에 포함. 시간 제약이 없으므로 Phase 0~7이 안정화된 뒤 마지막 단계로 진행. Graph Risk Engine(Phase 3)에서 이미 그래프 구조를 다루므로 자연스러운 확장이며, 11번 차별점(경쟁팀이 하기 어려운 부분)의 핵심이라 완주 가치가 큼

---

## 6. 제출서류(붙임4 제안요약서) 대비 정합성 조정

제출된 참가 신청서(붙임4)를 기준으로 AI/Backend/Data 스펙과 대조해서 반영한 변경사항:

1. **cash_claims에 Future Cash Registry 필드 추가**: 제출서류 2-3절에 명시된 Claim ID/Issuer/Document Hash/Status/Financing Status를 스키마에 반영 (1절 cash_claims 테이블 참고)
2. **chain_status 5단계 상태 모델 추가**: 제출서류가 REGISTERED/VERIFIED/FINANCED/REVOKED/SETTLED로 명시한 상태값을 cash_claims.chain_status로 신설. 기존 investment_commitments.status(딜 진행단계)는 그대로 유지하되 별개 레이어로 분리
3. **Document Intelligence에 expected_closing 추가**: 제출서류 143행 필드 목록 기준
4. **Seed Bridge 응답에 funding_probability/expected_closing/recommended_advance_capacity 추가**: 제출서류 123행 기준

### 코드로 해결할 수 없는 정합성 이슈 (팀 논의 필요)
제출서류(붙임1)의 공모주제 선택이 **"❸ 소상공인·골목상권 디지털 금융"**으로 체크되어 있는데, 실제 제안내용(붙임4)은 전부 **스타트업·투자자·B2B 벤처금융**을 다룸 (소상공인/골목상권 언급 없음). 이건 코드나 데이터 스키마로 해결할 문제가 아니라 발표/피칭 자료에서 "스타트업도 넓은 의미의 소상공인 생태계 일부"라는 식으로 연결고리를 만들어야 하는 문제라, 팀(강소현·이신우)과 논의가 필요함. Data 시나리오의 "스타트업 A/B" 자체를 소상공인처럼 재framing할지 여부는 결정 후 알려주면 반영.

---

## 7. Node ↔ ai-service 실제 계약 및 필드 매핑

ai-service는 DB에 붙지 않는 순수 계산 서비스라, DB 참조 키(cash_claim_id 등)가 아니라
**원시 피처 값을 직접** payload로 받는다. 2절의 API 명세는 Node가 클라이언트(프론트/앱)에
노출하는 API 형태이고, 아래는 Node 내부에서 ai-service를 호출할 때 실제로 보내는 형태다.
Node의 aiServiceClient가 이 매핑을 전담한다.

### ai-service 실제 엔드포인트 (service/schemas.py 기준, 확정)

**POST /predict/document-intelligence**
- Request: `{ document_text: string, document_type: "term_sheet"|"contract"|"invoice" }`
- Response: `{ amount, counterparty, payment_date, expected_closing, conditions_precedent[], termination_clause, payment_term }`
- Node 매핑: 문서 원문 텍스트를 확보(업로드 파일 파싱 or 저장된 텍스트 조회)해서 전달

**POST /predict/time-to-cash**
- Request: `{ amount, renewal_rate(0~100), network_centrality(0~1), relationship_type: "poc"|"contract"|"recurring", historical_delay_days }`
- Response: `{ payment_probability, expected_settlement_days, p30, p60, p90 }`
- Node 매핑: `invoices` + `counterparties` 조인 — amount는 invoices.amount, renewal_rate/relationship_type은 counterparties, historical_delay_days는 invoices.historical_delay_days, network_centrality는 counterparties.network_centrality

**POST /predict/network-credit**
- Request: `{ amount(optional, default 10000000), renewal_rate, network_centrality, relationship_type, historical_delay_days, active_recurring_contracts(int, default 0), counterparty_tier: "general"|"midsize"|"large_corp"(default "general") }`
- Response: `{ network_credit_score, counterparty_risk }`
- Node 매핑: time-to-cash와 동일 소스 + **신규 계산 필요**:
  - `active_recurring_contracts`: 해당 startup의 counterparties 중 relationship_type="recurring"인 건수
  - `counterparty_tier`: counterparties.name 기반 분류 규칙 필요 (예: 미리 정의된 대기업 계열사 목록에 있으면 large_corp, 병원/중견 규모면 midsize, 그 외 general) — data 레포의 시드 데이터 기준으로 매핑 테이블 작성

**POST /predict/seed-bridge**
- Request: `{ committed_amount, expected_closing_date(YYYY-MM-DD), investor_track_record_score(0~100), status, runway_months }`
- Response: `{ seed_bridge_score, funding_probability, expected_closing, recommended_advance_capacity, factors: {investor_trust, diligence_stage, runway, closing_proximity} }`
- Node 매핑: `investment_commitments` + `investors` + `startups` 조인 — committed_amount/expected_closing_date/status는 investment_commitments, investor_track_record_score는 investors, runway_months는 startups

**POST /predict/recovery-option**
- Request: `{ outstanding_bridge, current_cash, verified_receivables, monthly_burn, runway_months, past_investment_count(int) }`
- Response: `{ recommended_option: "A"|"B"|"C"|"D", confidence, class_probabilities: {A,B,C,D} }`
- Node 매핑: `advances`(outstanding_bridge) + `startups`(current_cash, monthly_burn, runway_months) + `invoices` 합산(verified_receivables) + `investment_commitments` 건수(past_investment_count)

**GET /health** → `{ status: "ok", models_loaded: [...] }`
