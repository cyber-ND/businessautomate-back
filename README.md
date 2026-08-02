# businessautomate-back

API for BusinessAutomate — the self-serve AI automation audit. Claude interviews a
business owner, then generates an audit of what is silently costing them money.

Deployed on Railway. The frontend lives in a separate repo
([businessautomate-front](https://github.com/cyber-ND/businessautomate-front)).

## Stack

| Layer    | Choice                   |
| -------- | ------------------------ |
| Runtime  | Node 22, ESM, TypeScript |
| HTTP     | Fastify 5                |
| Database | PostgreSQL via Prisma    |
| AI       | Claude (Anthropic)       |
| Payments | Paystack                 |
| Email    | Resend                   |

### Deliberate departures from `TECH_MODEL.md`

- **No Redis or BullMQ.** Report generation is tracked with a status column on
  `Report` and polled by the client. Four fewer moving parts for the same
  behaviour; the module boundary is preserved so a real queue can be dropped in
  later without touching callers.
- **Paystack, not Stripe.** Stripe is not fully available in Nigeria.
- **Claude Opus 5 / Sonnet 5**, not the `claude-opus-4-8` named in the doc.

## Running locally

```sh
npm install
cp .env.example .env    # then fill in ANTHROPIC_API_KEY
npm run setup           # starts Postgres in Docker and applies migrations
npm run dev
```

Requires Docker running. `npm run setup` is idempotent — safe to re-run.

`GET /health` returns `{"status":"ok"}` without touching anything.
`GET /ready` additionally confirms the database answers, and returns 503 if it
does not — so a deploy that cannot reach Postgres is visibly broken rather than
failing one request at a time.

### Where the database lives

| Environment | Database                          | `DATABASE_URL`                            |
| ----------- | --------------------------------- | ----------------------------------------- |
| Local       | Postgres 16 in Docker, port 5433  | in `.env`, points at `localhost:5433`      |
| Production  | Railway managed Postgres          | injected by Railway, private network       |

Railway's `DATABASE_PUBLIC_URL` is deliberately unused. Its TCP proxy has no
hostname provisioned, so the value resolves to `@:/railway` with an empty host —
and connecting to a Railway database from outside its network bills egress
regardless. The deployed service uses the private `DATABASE_URL` Railway injects
for it, which costs nothing and needs no configuration here.

Port 5433 rather than 5432 so the container cannot collide with a Postgres
already installed on the machine.

## Judging the audit

The audit is the product, so it is testable on its own — no database, no HTTP, no
frontend. With `ANTHROPIC_API_KEY` set:

```sh
npm run audit                  # list fixtures
npm run audit -- salon         # paid tier (Opus 5)
npm run audit -- salon --free  # free tier (Sonnet 5)
npm run audit -- salon --json  # raw audit JSON
```

Output labels every field `FREE` or `LOCKED`, matching the paywall split, so the
question "is the free half tantalising, and is the locked half worth paying
for?" can be answered by eye before any UI exists.

Fixtures live in `src/scripts/fixtures.ts`. The `vague` fixture is deliberately
thin: triage should want a follow-up question there, and if it does not, the
triage prompt is too permissive.

### Measurements

All on the `salon` fixture, 3,493 input tokens:

| Tier | Model      | Effort | Wall clock | Output tokens | Cost    |
| ---- | ---------- | ------ | ---------- | ------------- | ------- |
| Paid | Opus 5     | high   | 113.7s     | 7,268         | $0.199  |
| Free | Sonnet 5   | high   | 129.2s     | 11,634        | $0.123  |
| Free | Sonnet 5   | medium | 76.8s      | 7,239         | $0.079  |

Two findings worth keeping in mind:

**Effort matters more than model.** Sonnet at `high` was *slower* than Opus at
`high` and noticeably thinner — it spent the budget thinking rather than
writing. Dropping free to `medium` cut 40% of the latency and 35% of the cost
with no visible quality loss. Retune via `AI_EFFORT_FREE` / `AI_EFFORT_PAID`
rather than by switching models.

**Generation takes 75-115 seconds, not 20.** `DESIGN.md` budgets a ~20s
"analyzing" screen; that is not reachable at this quality. The funnel has to
either hold attention for a minute and a half, or hand the report over by email
when it is ready.

Cost consequence: `BUSINESS_MODEL.md` estimates ~$400/month for 10,000 free
audits. At $0.079 each that is ~$790. Still trivial against a single $49 sale,
but the doc's figure is roughly half the real one.

## Scripts

| Script                | Does                                           |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | Watch mode via tsx                             |
| `npm run audit -- salon` | Generate one real audit from a fixture and print it |
| `npm run build`       | `prisma generate` then `tsc`                   |
| `npm start`           | Run the compiled server (production)           |
| `npm run typecheck`   | Types only, no emit                            |
| `npm run prisma:push` | Sync the schema to the database (no migration) |

## API

| Method | Path                       | Returns | Notes                                        |
| ------ | -------------------------- | ------- | -------------------------------------------- |
| `POST` | `/api/reports`             | 202     | Start an audit. Body is the intake.          |
| `GET`  | `/api/reports/:id`         | 200     | Poll status; audit appears once COMPLETED.   |
| `POST` | `/api/reports/:id/answers` | 200     | Answer the adaptive follow-up question.      |
| `POST` | `/api/reports/:id/retry`   | 200     | Retry a FAILED generation.                   |
| `POST` | `/api/checkout/:reportId`  | 200     | Start a payment; returns the Paystack URL.   |
| `POST` | `/api/webhooks/paystack`   | 200/401 | Payment confirmation. Signature-verified.    |
| `GET`  | `/health`                  | 200     | Liveness. Touches nothing.                   |
| `GET`  | `/ready`                   | 200/503 | Readiness. Confirms the database answers.    |

### The report lifecycle

```
POST /api/reports  →  202 { id, status: PENDING }
                          ↓   (background, no HTTP request is waiting)
                      triage: is the intake rich enough?
                          ↓                        ↓
                   needs a question            good to go
                          ↓                        ↓
                  AWAITING_ANSWERS             PROCESSING
                          ↓                        ↓  75-115s
        POST /:id/answers  ──────────────→     COMPLETED  (or FAILED)
```

Creation returns **202, not 201**: the row exists but the audit does not.
Nothing waits on the model inside a request — triage alone is 4-5 seconds and
generation over a minute. The client polls `GET /api/reports/:id`.

`POST /:id/answers` takes only the answer. The *question* is read from the
report's stored `pendingQuestion`, so a client cannot pair an answer with a
question of its own choosing and steer what reaches the prompt.

Status codes worth knowing: **409** means the request was well-formed but the
report is not in a state that accepts it (usually a double submit); **400**
means the intake itself was malformed.

### What a free viewer gets

Gating is a pure function over the stored audit ([`gating.ts`](src/modules/reports/gating.ts)),
never a second generation — free and paid viewers read the same document.

| Field                                            | Free | Paid |
| ------------------------------------------------ | :--: | :--: |
| `businessSummary`, `totals`                       |  ✅   |  ✅   |
| `problem`, `monthlyCostUsd`, `hoursLostPerWeek`   |  ✅   |  ✅   |
| `monthlySavingsUsd`, `hoursSavedPerWeek`          |  ✅   |  ✅   |
| `solutionToolCostUsd`, `toolCount` (the teaser)   |  ✅   |  —   |
| `solution`, `tools`, `firstStep`                  |  ❌   |  ✅   |
| `roadmap`                                         |  ❌   |  ✅   |

`paid` is derived from `Report.paidAt`, which only a signature-verified Paystack
webhook sets. It is never taken from anything the client supplies.

## Payments

Paystack, not Stripe — Stripe is not fully available in Nigeria.

**One payment unlocks one report, never an account.** `Payment.reportId` plus
`Report.paidAt` is the entire entitlement model, so auditing a second business
requires a second payment by construction rather than by policy. There is no
abuse detection to write.

The reference is generated by us before the customer reaches Paystack, so a
webhook can never arrive for a payment we have no record of. It is unique-
constrained and doubles as the idempotency key.

Three properties the webhook handler has to get right, all covered by
`npm run payment:simulate -- --test-guards`:

- **Signature verified against the raw bytes.** Paystack signs the body exactly
  as sent; re-serialising parsed JSON reorders keys and breaks the signature, so
  the webhook route runs in its own Fastify scope with a buffer-preserving
  parser. Comparison is constant-time — a plain `===` leaks how much of a forged
  signature was correct.
- **Idempotent.** Paystack retries. A replay must not unlock twice or move the
  `paidAt` the 30-day re-run window is measured from.
- **Always 200 once the signature is good**, even for events we ignore. A
  non-2xx tells Paystack to retry an event we will never handle.

### Testing payments without money

```sh
npm run payment:simulate                  # unlock the newest completed report
npm run payment:simulate -- --test-guards # also assert forgery and replay are handled
```

Runs in-process via `app.inject()` — no server, no network, no Paystack account
needed. Only the checkout-URL call (`POST /api/checkout/:reportId`) requires a
real `PAYSTACK_SECRET_KEY`, since that one genuinely talks to Paystack.

## Branching

`main` is the deployable branch. `dev` is integration. Every feature or milestone
branch is cut from `dev`.
