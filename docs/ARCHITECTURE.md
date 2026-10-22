# IES architecture decisions

## Boundaries

| Boundary | Technology | Responsibility |
|---|---|---|
| Web client | React 18, TypeScript, MUI | Upload, queue visibility, review, correction and audit views |
| System API | Node.js 22, TypeScript, Fastify | Security, ingestion, review, query and audit endpoints |
| Processor | Node.js 22, TypeScript | Durable task leasing, concurrent orchestration, extraction, validation, retry/dead-letter handling |
| Extraction | Google Gemini via `@google/genai` | Read the PDF/image directly and return the canonical schema |
| Persistence | PostgreSQL | Jobs, invoice records, fields, corrections and immutable audit events |
| Work queue | PostgreSQL | Transactional enqueue, leasing, retries and crash recovery without dual-write gaps |
| Integration events | Kafka-compatible extension point | Optional downstream publication after the core transaction commits |

## Processing flow

1. The API streams an upload to a generated path while calculating SHA-256 and records the chosen invoice type (`STANDARD` or `TES`).
2. It validates filename, extension, magic bytes, size and duplicate hash. Duplicates are labelled but remain distinct jobs.
3. The job, audit event and processing task commit atomically before processing begins.
4. The processor leases the task and calls Gemini with the prompt and response schema for the job's invoice type. Large files use the Files API instead of inline data. If schema-constrained decoding is rejected, one prompt-only retry is made and the result is forced into review.
5. The normaliser coerces values without inventing any (missing fields stay null) and stamps `source: "gemini"`.
6. Validation applies authoritative rules: mandatory fields, ISO currency and date, amount reconciliation (lines + tax + shipping + other - discount = total), IMO check digit and VVD pattern. Confidence is derived from these checks, not from model self-report.
7. The UI shows source and extracted values side by side. Corrections are audited and can be used as labelled data for accuracy measurement only after approval.
8. A reviewer can stream an invoice or batch audit ZIP: source, exact extraction, validation, revisions and events, plus a correction template.

Known gap: the Node services do not enforce a page-count limit (the previous Python worker did). Only the 20 MB size limit applies; add a page check if long packets must be rejected up front.

## Performance model

200 invoices/hour is 3.33/minute. With a 15 s p95 target a single slot is not enough once variance is included, so the processor runs several concurrent slots (`IES_PROCESSOR_CONCURRENCY`, default 6) bounded by Gemini rate limits. Latency is measured from upload acceptance to `extraction_completed_at` (queue wait included, human review excluded). It must be measured at a sustained arrival rate, not a burst, otherwise queue wait dominates.

## Deployment model

- Local Compose binds every port to loopback and puts the browser behind a same-origin Nginx proxy.
- API, processor and web images run non-root with health probes and memory bounds.
- The deployment keeps one API and one processor replica because both read and write documents on the same local volume.
- PostgreSQL, ingress and secrets are environment services.

## Accuracy model

Accuracy is calculated at field level on a frozen, labelled holdout. Required-field exact/normalised match, line-item F1 and full-document success are reported separately. Confidence is a routing signal, not a substitute for measured accuracy. Document confidence is capped by the five required fields, so strong optional fields cannot hide a missing invoice number, date, vendor, currency or total. Human-reviewed fields keep their reviewer-assigned confidence.

## Security model

- Production authentication is OIDC/JWT (Microsoft Entra ID compatible).
- Uploaded names never become storage paths.
- Original documents and derived PII are excluded from Git.
- Secrets (database password, Gemini API key) come from environment variables or a secret manager; the processor refuses to start in production without a Gemini key.
- **Third-party processing:** every document is sent to the Gemini API. Verify the plan's data-use and retention terms, region and any contractual requirements before using real supplier or bank data.
- Logs use identifiers and timings, not invoice text or bank-account values.
- Every state transition and reviewer correction emits an append-only audit event.
- Audit downloads are tenant-scoped, available after processing, recorded as events, marked private/no-store and streamed without persisting copies.
