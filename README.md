# Invoice Extraction System (IES)

Cloud-agnostic invoice ingestion, AI extraction, validation and human review.

## Scope

- Batch upload for PDF, PNG, JPEG and TIFF invoices (standard and terminal/TES invoices)
- Safe filenames, MIME/magic-byte validation, size limits and SHA-256 duplicate detection; duplicates are labelled but still processed as distinct batch items
- Asynchronous job lifecycle with source-document retention and audit events
- Direct document extraction with Google Gemini (`@google/genai`), constrained to one canonical JSON schema
- Deterministic validation (required fields, ISO currency/date, amount reconciliation) and validation-derived confidence
- React/MUI operational dashboard and invoice review cockpit
- Downloadable per-invoice and per-batch audit ZIPs
- Versioned PostgreSQL schema with normalized extraction, audit, benchmark and durable task tables

## Architecture

```text
React 18 + MUI
      |
Node.js 22 + Fastify API microservice
      |--- PostgreSQL (transactional state + audit + durable task queue)
      `--- shared document storage
                |
Node.js 22 processor microservice  --HTTPS-->  Gemini API
      (leases tasks from PostgreSQL, validates, persists)
```

The API owns HTTP ingestion, review and query endpoints. The processor leases durable tasks from PostgreSQL, sends each document to Gemini, validates the result and stores an immutable extraction revision. There is no separate OCR service: the model reads the PDF/image directly.

**Data handling:** invoices are transmitted to the Gemini API. Confirm that the API plan's data-use terms and your organisation's policy allow this before processing real supplier or bank data. See [SECURITY.md](SECURITY.md).

## One-command container demo

Prerequisites: Docker Desktop or Docker Engine with Compose, and a Gemini API key.

1. Copy `.env.example` to `.env`; set a strong `POSTGRES_PASSWORD` and your `GEMINI_API_KEY`.
2. Build and start the stack:

   ```powershell
   docker compose up --build -d
   ```

3. Open `http://127.0.0.1:8088`. The API is on `http://127.0.0.1:8080` (readiness `/actuator/health/readiness`); the processor is on `http://127.0.0.1:8081/ready`.

`docker compose down` keeps the database and invoice volumes; do not use `down -v` if they must be preserved.

## Local developer mode

Prerequisites: PostgreSQL 15+, Node 22+ with pnpm 11.

1. `docker compose up -d postgres`
2. From `backend`: `pnpm install --frozen-lockfile`, `pnpm migrate`, then `pnpm dev:api` and `pnpm dev:processor` in separate terminals (export `GEMINI_API_KEY` and the variables from `.env.example` first).
3. From `frontend`: `pnpm install --frozen-lockfile && pnpm run dev`.

Every runtime uses PostgreSQL. Local and container demos default to authentication off; production must enable OIDC/JWT.

## Extraction audit packages

Open an invoice review page and select **Invoice audit** or **Batch audit** once processing finishes (`GET /api/v1/invoices/:id/audit`, `GET /api/v1/batches/:id/audit`). Each package contains the source, exact extracted-fields JSON, spreadsheet-safe CSV, validation result, revision history, audit events and an editable `review-template.json`. Packages can contain confidential data and are excluded from Git.

Processing can be stopped from the review screen (`POST /api/v1/invoices/:id/cancel`, `POST /api/v1/batches/:id/cancel`). Cancellation is durable and audited; an in-flight result is discarded rather than committed.

## Deploying

See [DEPLOY.md](DEPLOY.md) for a short-lived single-server deployment with Docker Compose.

## Performance and accuracy targets

| Target | Definition |
|---|---|
| Field accuracy >= 95% | Measured on a frozen, representative, labelled holdout |
| Latency < 15 s (p95) | Upload accepted to extraction completed (`latencyMs` includes queue wait) |
| Throughput >= 200 invoices/hour | Sustained run |

These are acceptance targets, not claims. They have not been measured against the Gemini pipeline.

## Confidential GitHub workflow

Do not push invoice samples, extracted JSON, API keys, database dumps or `.env` files. Before every push:

```powershell
./scripts/security-check.ps1
git status --short
git diff --cached
```

Use a hardware-backed SSH key or credential manager, 2FA, branch protection, secret scanning/push protection and least-privilege access.
