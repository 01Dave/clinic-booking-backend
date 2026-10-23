const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');

const API_KEY = process.env.API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!API_KEY || !DATABASE_URL) {
  console.error('API_KEY and DATABASE_URL environment variables are required');
  process.exit(1);
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false },
  max: 10,
});

const SCHEMA = `
create table if not exists slots (
  id text primary key,
  provider text not null,
  start_str text not null,
  end_str text not null,
  start_ts timestamptz not null
);
create table if not exists bookings (
  seq bigserial unique,
  id text primary key,
  slot_id text not null,
  name text not null,
  email text not null,
  status text not null,
  created_at timestamptz not null default now()
);
-- Level 3: the database itself guarantees one confirmed booking per slot.
create unique index if not exists one_confirmed_per_slot
  on bookings (slot_id) where status = 'confirmed';
create index if not exists bookings_email_seq on bookings (email, seq);
create table if not exists idempotency_keys (
  key text primary key,
  body_hash text not null,
  status int,
  response jsonb
);
create table if not exists booking_attempts (
  email text not null,
  ts timestamptz not null default now()
);
create index if not exists booking_attempts_email on booking_attempts (email, ts);
`;

// ---------- helpers ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn(c);
    await c.query('commit');
    return out;
  } catch (e) {
    try { await c.query('rollback'); } catch (_) {}
    throw e;
  } finally {
    c.release();
  }
}

function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') {
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  }
  return JSON.stringify(v === undefined ? null : v);
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const err = (status, message, extra = {}) => ({ status, body: { error: message }, ...extra });

const bookingOut = (r) => ({
  id: r.id,
  slot_id: r.slot_id,
  name: r.name,
  email: r.email,
  status: r.status,
  created_at: new Date(r.created_at).toISOString(),
});

function send(res, result) {
  if (result.headers) for (const [k, v] of Object.entries(result.headers)) res.set(k, v);
  res.status(result.status).json(result.body);
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');

// CORS (so the separately built web page can call this API from a browser)
app.use((req, res, next) => {
  res.set({
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-API-Key, Idempotency-Key',
    'Access-Control-Expose-Headers': 'Retry-After',
    'Access-Control-Max-Age': '86400',
  });
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Unauthenticated health check for the host (Render etc.)
app.get('/health', (req, res) => res.json({ ok: true }));

// Level 2: API key on every request
app.use((req, res, next) => {
  const given = req.get('X-API-Key') || '';
  const a = Buffer.from(given);
  const b = Buffer.from(API_KEY);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ error: 'invalid or missing API key' });
  }
  next();
});

app.use(express.json({ limit: '5mb' }));

// ---------- Level 1: reset ----------
app.post('/reset', async (req, res, next) => {
  try {
    const slots = isObj(req.body) ? req.body.slots : undefined;
    if (!Array.isArray(slots)) return res.status(400).json({ error: 'slots must be an array' });

    const seen = new Set();
    const rows = [];
    for (const s of slots) {
      if (!isObj(s)) return res.status(400).json({ error: 'each slot must be an object' });
      for (const f of ['id', 'provider', 'start', 'end']) {
        if (typeof s[f] !== 'string' || !s[f].trim()) {
          return res.status(400).json({ error: `slot ${f} is required` });
        }
      }
      const startTs = new Date(s.start);
      if (isNaN(startTs) || isNaN(new Date(s.end))) {
        return res.status(400).json({ error: 'slot start and end must be valid date-times' });
      }
      if (seen.has(s.id)) return res.status(400).json({ error: `duplicate slot id ${s.id}` });
      seen.add(s.id);
      rows.push([s.id, s.provider, s.start, s.end, startTs.toISOString()]);
    }

    await tx(async (c) => {
      await c.query('delete from bookings');
      await c.query('delete from idempotency_keys');
      await c.query('delete from booking_attempts');
      await c.query('delete from slots');
      for (const r of rows) {
        await c.query(
          'insert into slots (id, provider, start_str, end_str, start_ts) values ($1,$2,$3,$4,$5)',
          r
        );
      }
    });
    res.json({ ok: true, slots: rows.length });
  } catch (e) { next(e); }
});

// ---------- Level 1: list slots ----------
app.get('/slots', async (req, res, next) => {
  try {
    let provider = req.query.provider;
    if (Array.isArray(provider)) provider = provider[0];
    const r = await pool.query(
      `select s.id, s.provider, s.start_str, s.end_str,
              not exists (select 1 from bookings b where b.slot_id = s.id and b.status = 'confirmed') as available
         from slots s
        where ($1::text is null or s.provider = $1)
        order by s.start_ts, s.id`,
      [typeof provider === 'string' ? provider : null]
    );
    res.json({
      slots: r.rows.map((x) => ({
        id: x.id, provider: x.provider, start: x.start_str, end: x.end_str, available: x.available,
      })),
    });
  } catch (e) { next(e); }
});

// ---------- Level 5: rate limit (5 attempts / email / minute) ----------
// Returns 0 if allowed (and records the attempt), otherwise seconds to wait.
async function checkRate(email) {
  return tx(async (c) => {
    await c.query('select pg_advisory_xact_lock(hashtext($1))', [email]);
    await c.query(
      "delete from booking_attempts where email = $1 and ts < clock_timestamp() - interval '60 seconds'",
      [email]
    );
    const r = await c.query(
      `select count(*)::int as n,
              extract(epoch from (min(ts) + interval '60 seconds' - clock_timestamp())) as wait
         from booking_attempts where email = $1`,
      [email]
    );
    if (r.rows[0].n >= 5) return Math.max(1, Math.ceil(Number(r.rows[0].wait)));
    await c.query('insert into booking_attempts (email, ts) values ($1, clock_timestamp())', [email]);
    return 0;
  });
}

// ---------- Levels 1-3: create the booking ----------
async function attemptBooking(body) {
  const b = isObj(body) ? body : {};
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  if (email) {
    const wait = await checkRate(email);
    if (wait) {
      return err(429, 'too many booking attempts, try again later', {
        headers: { 'Retry-After': String(wait) },
        cache: false,
      });
    }
  }

  const slotId = typeof b.slot_id === 'string' ? b.slot_id.trim() : '';
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (!slotId) return err(400, 'slot_id is required');
  if (!name) return err(400, 'name is required');
  if (!email) return err(400, 'email is required');
  if (!EMAIL_RE.test(email)) return err(400, 'email is not valid');

  const slot = await pool.query('select id, start_ts from slots where id = $1', [slotId]);
  if (!slot.rowCount) return err(404, 'slot not found');
  if (new Date(slot.rows[0].start_ts).getTime() <= Date.now()) {
    return err(400, 'slot has already started');
  }

  try {
    const r = await pool.query(
      `insert into bookings (id, slot_id, name, email, status)
       values ($1,$2,$3,$4,'confirmed') returning *`,
      [crypto.randomUUID(), slotId, name, email]
    );
    return { status: 201, body: bookingOut(r.rows[0]) };
  } catch (e) {
    if (e.code === '23505') return err(409, 'slot already booked');
    throw e;
  }
}

// ---------- Level 4: idempotency ----------
async function withIdempotency(key, body, fn) {
  const hash = sha(stable(body));
  for (;;) {
    const ins = await pool.query(
      'insert into idempotency_keys (key, body_hash) values ($1,$2) on conflict do nothing returning key',
      [key, hash]
    );
    if (ins.rowCount) break; // we own this key

    // Someone else owns it: replay, reject, or wait for them to finish.
    let released = false;
    for (let i = 0; i < 100; i++) {
      const r = await pool.query(
        'select body_hash, status, response from idempotency_keys where key = $1',
        [key]
      );
      const row = r.rows[0];
      if (!row) { released = true; break; } // owner gave up (e.g. 429); try to own it
      if (row.body_hash !== hash) return err(422, 'Idempotency-Key was already used with a different body');
      if (row.status !== null) return { status: row.status, body: row.response };
      await sleep(50);
    }
    if (!released) return err(409, 'a request with this Idempotency-Key is still in progress');
  }

  try {
    const result = await fn();
    if (result.cache === false) {
      await pool.query('delete from idempotency_keys where key = $1', [key]);
    } else {
      await pool.query(
        'update idempotency_keys set status = $2, response = $3 where key = $1',
        [key, result.status, JSON.stringify(result.body)]
      );
    }
    return result;
  } catch (e) {
    await pool.query('delete from idempotency_keys where key = $1', [key]).catch(() => {});
    throw e;
  }
}

app.post('/bookings', async (req, res, next) => {
  try {
    const key = req.get('Idempotency-Key');
    const result = key
      ? await withIdempotency(key, req.body, () => attemptBooking(req.body))
      : await attemptBooking(req.body);
    send(res, result);
  } catch (e) { next(e); }
});

// ---------- Level 4: list a person's bookings (cursor pagination) ----------
app.get('/bookings', async (req, res, next) => {
  try {
    const email = typeof req.query.email === 'string' ? req.query.email.trim().toLowerCase() : '';
    if (!email) return res.status(400).json({ error: 'email is required' });

    let limit = 10;
    if (req.query.limit !== undefined) {
      const l = req.query.limit;
      if (typeof l !== 'string' || !/^\d+$/.test(l)) return res.status(400).json({ error: 'limit must be 1 to 50' });
      limit = parseInt(l, 10);
      if (limit < 1 || limit > 50) return res.status(400).json({ error: 'limit must be 1 to 50' });
    }

    let after = 0;
    if (req.query.cursor !== undefined) {
      const dec = typeof req.query.cursor === 'string'
        ? Buffer.from(req.query.cursor, 'base64url').toString('utf8') : '';
      if (!/^\d+$/.test(dec)) return res.status(400).json({ error: 'invalid cursor' });
      after = dec;
    }

    const r = await pool.query(
      `select * from bookings where email = $1 and seq > $2 order by seq limit $3`,
      [email, after, limit + 1]
    );
    const page = r.rows.slice(0, limit);
    const next_cursor = r.rows.length > limit
      ? Buffer.from(String(page[page.length - 1].seq)).toString('base64url')
      : null;
    res.json({ bookings: page.map(bookingOut), next_cursor });
  } catch (e) { next(e); }
});

// ---------- Level 1: get a booking ----------
app.get('/bookings/:id', async (req, res, next) => {
  try {
    const r = await pool.query('select * from bookings where id = $1', [req.params.id]);
    if (!r.rowCount) return res.status(404).json({ error: 'booking not found' });
    res.json(bookingOut(r.rows[0]));
  } catch (e) { next(e); }
});

// ---------- Level 3: cancel ----------
app.delete('/bookings/:id', async (req, res, next) => {
  try {
    const out = await tx(async (c) => {
      const r = await c.query('select * from bookings where id = $1 for update', [req.params.id]);
      if (!r.rowCount) return err(404, 'booking not found');
      if (r.rows[0].status === 'cancelled') return err(409, 'booking already cancelled');
      const u = await c.query(
        "update bookings set status = 'cancelled' where id = $1 returning *",
        [req.params.id]
      );
      return { status: 200, body: bookingOut(u.rows[0]) };
    });
    send(res, out);
  } catch (e) { next(e); }
});

// ---------- fallbacks ----------
app.use((req, res) => res.status(404).json({ error: 'not found' }));

app.use((e, req, res, next) => {
  if (e.type === 'entity.parse.failed') return res.status(400).json({ error: 'invalid JSON body' });
  if (e.type === 'entity.too.large') return res.status(400).json({ error: 'body too large' });
  console.error(e);
  res.status(500).json({ error: 'internal server error' });
});

pool
  .query(SCHEMA)
  .then(() => app.listen(PORT, () => console.log(`listening on ${PORT}`)))
  .catch((e) => { console.error('failed to initialise database', e); process.exit(1); });
