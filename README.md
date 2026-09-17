# CashGapBank Backend / AI / Data

CashGapBank에서 backend, AI service, seed data를 담당하는 repo입니다.  
이 문서는 로컬 실행, 서비스 통합, API 경계, 데이터 흐름을 빠르게 파악할 수 있도록 정리한 공개용 가이드입니다.

## Architecture

```text
Frontend / other service
  -> backend(Node.js, port 4000)
      -> PostgreSQL(seed/migration/data)
      -> ai-service(Python FastAPI, port 8000)
      -> chain verifier mock or real chain API
```

- `backend/`: REST API, DB store, orchestration, webhook 처리, chain 검증 연동
- `ai-service/`: FastAPI 기반 AI 예측 서비스. DB에 직접 접근하지 않고 backend가 넘긴 raw feature만 계산
- `data/`: PostgreSQL seed SQL과 같은 내용을 담은 JSON fixture
- `cash-gap-bank-spec.md`: 전체 서비스/DB/시나리오 기준 문서

## Service Boundary

backend가 시스템의 중심입니다.

- frontend 또는 외부 서비스는 기본적으로 `http://127.0.0.1:4000`의 backend API를 호출합니다.
- ai-service는 frontend가 직접 호출하지 않는 내부 계산 서비스입니다.
- ai-service에는 DB id를 넘기지 않습니다. backend가 DB에서 필요한 값들을 join해서 숫자/문자열/enum 형태의 raw feature로 넘깁니다.
- chain 검증은 `CHAIN_VERIFY_URL`이 있으면 실제 chain/team API로, 없으면 backend 내부 mock 로직으로 동작합니다.

## Quick Start

### 1. backend 의존성 설치

```bash
cd backend
npm install
```

### 2. ai-service 실행

로컬 Python으로 실행할 때:

```bash
cd ai-service
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt
.venv/Scripts/python -m uvicorn service.main:app --host 127.0.0.1 --port 8000
```

health check:

```bash
curl http://127.0.0.1:8000/health
```

정상 응답 예:

```json
{
  "status": "ok",
  "models_loaded": ["time_to_cash", "graph_risk", "seed_bridge", "recovery_policy"]
}
```

### 3. PostgreSQL과 ai-service를 Docker Compose로 같이 실행

backend 폴더에서 실행합니다.

```bash
cd backend
docker compose up -d
```

`backend/docker-compose.yml`은 다음을 띄웁니다.

- PostgreSQL: `127.0.0.1:55432`
- ai-service: `127.0.0.1:8000`

첫 DB 초기화 때 `backend/src/db/migrations/*.sql`을 먼저 실행하고, 그 다음 seed SQL을 넣습니다. seed 경로 기본값은 `../cash-gap-bank-data/seed/sql`이라서 현재 repo의 `data/seed/sql`을 쓰려면 아래처럼 지정하는 편이 안전합니다.

```bash
SEED_SQL_PATH=../data/seed/sql docker compose up -d
```

Windows PowerShell에서는:

```powershell
$env:SEED_SQL_PATH="../data/seed/sql"
docker compose up -d
```

### 4. backend API 실행

```bash
cd backend
$env:AI_SERVICE_URL="http://127.0.0.1:8000"
$env:CHAIN_VERIFY_URL="http://127.0.0.1:4010/chain/verify-claim"
npm run dev
```

별도 터미널에서 chain mock을 켤 수 있습니다.

```bash
cd backend
npm run mock:chain
```

backend health check:

```bash
curl http://127.0.0.1:4000/health
```

## Environment Variables

| 변수 | 기본/예시 | 의미 |
|---|---|---|
| `PORT` | `4000` | backend API port |
| `AI_SERVICE_URL` | `http://127.0.0.1:8000` | backend가 호출할 Python AI service |
| `CHAIN_VERIFY_URL` | empty or `http://127.0.0.1:4010/chain/verify-claim` | 실제 chain 검증 API 또는 mock |
| `STORE_BACKEND` | `auto` | `auto`, `memory`, `pg` 중 선택 |
| `DATABASE_URL` | optional | PostgreSQL 직접 연결 문자열 |
| `POSTGRES_HOST` | `127.0.0.1` | PostgreSQL host |
| `POSTGRES_PORT` | `55432` | Docker PostgreSQL 외부 port |
| `POSTGRES_DB` | `cashgapbank` | DB 이름 |
| `POSTGRES_USER` | `cashgapbank` | DB user |
| `POSTGRES_PASSWORD` | `cashgapbank_dev_password` | DB password |
| `SEED_SQL_PATH` | `../data/seed/sql` 권장 | seed SQL 폴더 |
| `ANTHROPIC_API_KEY` | optional | ai-service Document Intelligence에서 Anthropic 사용 |

`STORE_BACKEND=auto`는 DB 연결 정보가 있으면 PostgreSQL을 쓰고, 없으면 memory store를 씁니다. 빠른 API 테스트만 할 때는 `STORE_BACKEND=memory`가 편합니다.

## Backend API

기본 URL: `http://127.0.0.1:4000`

| Method | Path | 역할 |
|---|---|---|
| `GET` | `/health` | backend 상태 확인 |
| `POST` | `/api/document-intelligence/extract` | 문서 텍스트/URL에서 금액, 상대방, 조건 등 추출 |
| `POST` | `/api/graph/counterparty` | counterparty 생성/업데이트 |
| `GET` | `/api/scores/network-credit/:startup_id` | startup의 counterparty network credit 평균 점수 |
| `POST` | `/api/predict/time-to-cash` | invoice 기반 cash claim의 회수 확률/예상 정산일 |
| `GET` | `/api/scores/seed-bridge/:investment_commitment_id` | 투자확약 기반 seed bridge 점수 |
| `POST` | `/api/cash-claims` | cash claim 생성, chain 검증, AI score 계산, advance 생성 |
| `POST` | `/api/advance-limit/recalculate` | 투자확약 상태 변경 후 advance limit 재계산 |
| `POST` | `/api/recovery/analyze` | advance별 recovery waterfall 추천 |
| `POST` | `/api/webhooks/credential-status-changed` | VC credential 상태 변경 webhook |
| `POST` | `/api/webhooks/credential-revoked` | credential revoked webhook, recovery trigger |
| `POST` | `/api/webhooks/chain-status-changed` | Future Cash Registry chain status 변경 webhook |

## AI Service API

기본 URL: `http://127.0.0.1:8000`

backend 내부에서 호출하는 서비스입니다.

| Method | Path | 모델/기능 |
|---|---|---|
| `GET` | `/health` | 모델 로드 상태 |
| `POST` | `/predict/document-intelligence` | term sheet, contract, invoice 정보 추출 |
| `POST` | `/predict/time-to-cash` | invoice 정산 가능성/기간 예측 |
| `POST` | `/predict/network-credit` | counterparty graph risk 기반 신용 점수 |
| `POST` | `/predict/seed-bridge` | 투자확약 기반 bridge 가능성 |
| `POST` | `/predict/recovery-option` | recovery waterfall 옵션 A/B/C/D 추천 |

ai-service 모델 artifact는 `ai-service/models/artifacts/*.joblib`에 들어 있습니다. 재학습 진입점은 `ai-service/train_all.py`입니다.

## Data Flow

### cash claim 생성 흐름

`POST /api/cash-claims`

1. backend가 `startup_id`, `source_type`, `source_id`, `document_text`를 받습니다.
2. source가 `invoice`인지 `investment_commitment`인지 확인합니다.
3. backend가 ai-service의 Document Intelligence를 호출합니다.
4. backend가 chain verifier를 호출해 `verified`, `duplicate_financing`을 확인합니다.
5. backend가 `cash_claims`를 생성합니다.
6. source가 `investment_commitment`이면 Seed Bridge 모델을 호출합니다.
7. source가 `invoice`이면 Network Credit과 Time-to-Cash 모델을 호출합니다.
8. backend가 `ai_scores`와 `advances`를 생성하고 `safe_advance_capacity`를 반환합니다.

예시 요청:

```bash
curl -X POST http://127.0.0.1:4000/api/cash-claims \
  -H "content-type: application/json" \
  -d '{
    "startup_id": "b2222222-2222-4222-8222-222222222222",
    "source_type": "invoice",
    "source_id": "d1111111-1111-4111-8111-111111111111",
    "document_text": "Invoice amount KRW 120000000 from Samsung SDS due 2026-10-15"
  }'
```

### Recovery 흐름

`POST /api/recovery/analyze`

1. backend가 advance id로 `advances -> cash_claims -> startups`를 조회합니다.
2. unpaid invoice 합계, 현재 현금, burn, runway, 과거 투자확약 수를 feature로 만듭니다.
3. ai-service `/predict/recovery-option`이 A/B/C/D 중 하나를 추천합니다.
4. backend가 사람이 읽기 쉬운 `recommended_option_code`까지 붙여 반환합니다.

옵션 의미:

- `A_collateral_swap`: 검증된 receivable로 담보 교체
- `B_installment`: installment 방식 회수
- `C_investor_match`: investor 매칭
- `D_partial_restructure`: 부분 구조조정

## Seed Data

seed SQL: `data/seed/sql/001_cash_gap_bank_seed.sql`  
JSON fixture: `data/seed/json/cash_gap_bank_seed.json`

주요 demo scenario:

- Scenario A, Seed Bridge: `LumaLedger AI`
- Scenario B, Supply Credit: `CareLink Ops`
- Future Cash Registry: `REGISTERED`, `VERIFIED`, `FINANCED`, `REVOKED`, `SETTLED` 상태가 모두 seed에 포함
- Recovery Waterfall: A/B/C/D 옵션이 각각 한 번씩 나오도록 `recovery_events`가 설계됨

중요한 test/demo row:

| 용도 | ID |
|---|---|
| Samsung SDS strong invoice | `d1111111-1111-4111-8111-111111111111` |
| Hyundai AutoEver strong invoice | `d2222222-2222-4222-8222-222222222222` |
| duplicate/blockchain risk invoice | `d6666666-6666-4666-8666-666666666666` |
| duplicate financing claim candidate | `e1111111-1111-4111-8111-111111111111` |

## Integration Checklist

서비스 통합 전 확인할 항목입니다.

1. `cd backend` 후 `npm install`이 끝났는지 확인
2. `ai-service`가 `http://127.0.0.1:8000/health`에서 `ok`를 반환하는지 확인
3. PostgreSQL을 쓸 경우 `backend`에서 `SEED_SQL_PATH=../data/seed/sql docker compose up -d`
4. backend 실행 시 `AI_SERVICE_URL=http://127.0.0.1:8000` 지정
5. 실제 chain verifier가 없으면 `npm run mock:chain` 후 `CHAIN_VERIFY_URL=http://127.0.0.1:4010/chain/verify-claim`
6. client/frontend는 backend의 `http://127.0.0.1:4000`을 API base URL로 설정
7. `/health`, `/api/document-intelligence/extract`, `/api/cash-claims` 순서로 smoke test

## Tests

backend 기본 테스트:

```bash
cd backend
npm test
```

AI service 실제 실행까지 포함한 통합 테스트:

```bash
cd backend
npm run test:integration:ai
```

PostgreSQL 통합 테스트:

```bash
cd backend
npm run test:integration:pg
```
