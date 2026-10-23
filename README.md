# Clinic booking API

Node.js + Express + Postgres. Implements levels 1–5 of the Koya assessment spec.

## Run locally

```bash
npm install
export API_KEY=dev-key
export DATABASE_URL=postgres://localhost/clinic
npm start
```

Tables are created automatically on startup.

## Deploy (Render + Neon)

1. Create a free Postgres database on Neon and copy its connection string.
2. Push this repo to GitHub.
3. On Render, create a Web Service from the repo: build `npm install`, start `npm start`.
4. Set env vars `API_KEY` and `DATABASE_URL`.
5. Health check path: `/health` (the only endpoint that skips the API key).

## How each level is enforced

| Level | Approach |
|-------|----------|
| 2 | Middleware checks `X-API-Key` (constant-time compare); validation trims name/email and lower-cases email |
| 3 | Partial unique index `one_confirmed_per_slot` on `bookings(slot_id) where status='confirmed'`; concurrent inserts lose with a unique violation, mapped to 409. Cancelling frees the slot |
| 4 | `idempotency_keys` table: key is reserved atomically (insert … on conflict do nothing), response stored, replays return it; different body hash returns 422. Listing uses a cursor on a `bigserial` sequence |
| 5 | `booking_attempts` table, per-email Postgres advisory lock, sliding 60s window; 6th attempt gets 429 + `Retry-After` |

All state lives in Postgres, so it survives restarts and works with more than one instance.
