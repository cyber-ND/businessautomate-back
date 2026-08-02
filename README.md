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
cp .env.example .env    # then fill in the values
npm run dev
```

`GET /health` should return `{"status":"ok"}`.

## Scripts

| Script                | Does                                           |
| --------------------- | ---------------------------------------------- |
| `npm run dev`         | Watch mode via tsx                             |
| `npm run build`       | `prisma generate` then `tsc`                   |
| `npm start`           | Run the compiled server (production)           |
| `npm run typecheck`   | Types only, no emit                            |
| `npm run prisma:push` | Sync the schema to the database (no migration) |

## Branching

`main` is the deployable branch. `dev` is integration. Every feature or milestone
branch is cut from `dev`.
