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

## Scripts

| Script                | Does                                           |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | Watch mode via tsx                             |
| `npm run audit -- salon` | Generate one real audit from a fixture and print it |
| `npm run build`       | `prisma generate` then `tsc`                   |
| `npm start`           | Run the compiled server (production)           |
| `npm run typecheck`   | Types only, no emit                            |
| `npm run prisma:push` | Sync the schema to the database (no migration) |

## Branching

`main` is the deployable branch. `dev` is integration. Every feature or milestone
branch is cut from `dev`.
