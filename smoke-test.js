// Smoke test for the clinic booking API (levels 1-5).
// Usage: BASE_URL=http://localhost:3000 API_KEY=dev-key node smoke-test.js
// WARNING: calls POST /reset, which wipes all bookings and slots. Run it BEFORE you submit,
// never against the deployment after submission.

const BASE = (process.env.BASE_URL || process.argv[2] || 'http://localhost:3000').replace(/\/$/, '');
const KEY = process.env.API_KEY || process.argv[3] || 'dev-key';

let passed = 0;
let failed = 0;
const run = Math.random().toString(36).slice(2, 8);
const email = (tag) => `${tag}-${run}@example.com`;

async function api(method, path, { body, headers = {}, key = KEY } = {}) {
  const h = { ...headers };
  if (key !== null) h['X-API-Key'] = key;
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch (_) {}
  return { status: res.status, json, headers: res.headers };
}

function check(name, cond, detail) {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail !== undefined ? '  -> ' + JSON.stringify(detail) : ''}`); }
}

const book = (slot_id, name, mail, headers) =>
  api('POST', '/bookings', { body: { slot_id, name, email: mail }, headers });

async function main() {
  console.log(`Testing ${BASE}\n`);

  // ---------- Level 1 ----------
  console.log('Level 1: slots, book, lookup');
  const slots = [];
  for (let i = 1; i <= 12; i++) {
    const day = String(i).padStart(2, '0');
    slots.push({
      id: `s${i}`,
      provider: i <= 6 ? 'Dr Ade' : 'Dr Bola',
      start: `2030-12-${day}T09:00:00Z`,
      end: `2030-12-${day}T09:30:00Z`,
    });
  }
  // Insert out of order to check sorting, plus one slot in the past.
  slots.reverse();
  slots.push({ id: 'past', provider: 'Dr Ade', start: '2020-01-01T09:00:00Z', end: '2020-01-01T09:30:00Z' });

  let r = await api('POST', '/reset', { body: { slots } });
  check('reset returns 200', r.status === 200, r);

  r = await api('GET', '/slots');
  check('GET /slots returns 200', r.status === 200, r.status);
  const list = (r.json && r.json.slots) || [];
  check('all slots returned', list.length === 13, list.length);
  check('earliest start first', list[0] && list[0].id === 'past' && list[1] && list[1].id === 's1',
    list.slice(0, 2).map((s) => s.id));
  check('slot shape keeps original timestamps',
    list[1] && list[1].start === '2030-12-01T09:00:00Z' && list[1].available === true, list[1]);

  r = await api('GET', '/slots?provider=Dr%20Bola');
  check('provider filter (exact match)',
    r.json && r.json.slots.length === 6 && r.json.slots.every((s) => s.provider === 'Dr Bola'), r.json);

  r = await book('s1', 'Ada Obi', email('ada'));
  check('book returns 201 confirmed', r.status === 201 && r.json.status === 'confirmed' && !!r.json.id, r);
  const booking = r.json;

  r = await api('GET', `/bookings/${booking && booking.id}`);
  check('GET /bookings/:id returns booking', r.status === 200 && r.json.id === booking.id, r);
  r = await api('GET', '/bookings/does-not-exist');
  check('GET unknown booking is 404 with error body', r.status === 404 && typeof r.json.error === 'string', r);
  r = await api('GET', '/slots');
  check('booked slot shows available:false', r.json.slots.find((s) => s.id === 's1').available === false);

  // ---------- Level 2 ----------
  console.log('\nLevel 2: auth and validation');
  r = await api('GET', '/slots', { key: null });
  check('missing key -> 401', r.status === 401 && typeof r.json.error === 'string', r);
  r = await api('GET', '/slots', { key: 'wrong-key' });
  check('wrong key -> 401', r.status === 401, r.status);
  r = await api('POST', '/reset', { body: { slots: [] }, key: null });
  check('reset also needs key', r.status === 401, r.status);

  const v = email('val');
  r = await api('POST', '/bookings', { body: { name: 'A', email: v } });
  check('missing slot_id -> 400', r.status === 400 && typeof r.json.error === 'string', r);
  r = await api('POST', '/bookings', { body: { slot_id: 's2', name: '   ', email: v } });
  check('blank name -> 400', r.status === 400, r.status);
  r = await api('POST', '/bookings', { body: { slot_id: 's2', name: 'A' } });
  check('missing email -> 400', r.status === 400, r.status);
  r = await api('POST', '/bookings', { body: { slot_id: 's2', name: 'A', email: 'not-an-email' } });
  check('invalid email -> 400', r.status === 400, r.status);
  r = await book('nope', 'A', v);
  check('unknown slot -> 404', r.status === 404, r.status);
  r = await book('past', 'A', v);
  check('slot already started -> 400', r.status === 400, r);

  const mixed = `  TrimMe-${run}@Example.COM  `;
  r = await book('s2', '  Spacey Name  ', mixed);
  check('name trimmed, email trimmed + lower-cased',
    r.status === 201 && r.json.name === 'Spacey Name' && r.json.email === `trimme-${run}@example.com`, r.json);
  const spacey = r.json;

  // ---------- Level 3 ----------
  console.log('\nLevel 3: double booking and cancel');
  r = await book('s2', 'Someone Else', email('other'));
  check('already booked slot -> 409', r.status === 409 && typeof r.json.error === 'string', r);

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, i) => book('s3', `Racer ${i}`, email(`race${i}`)))
  );
  const wins = results.filter((x) => x.status === 201).length;
  const conflicts = results.filter((x) => x.status === 409).length;
  check('20 simultaneous requests: exactly one 201', wins === 1, results.map((x) => x.status));
  check('...and the other 19 are 409', conflicts === 19, results.map((x) => x.status));

  r = await api('DELETE', `/bookings/${spacey.id}`);
  check('cancel -> 200 status cancelled', r.status === 200 && r.json.status === 'cancelled', r);
  r = await api('DELETE', `/bookings/${spacey.id}`);
  check('cancel again -> 409', r.status === 409, r.status);
  r = await api('DELETE', '/bookings/does-not-exist');
  check('cancel unknown -> 404', r.status === 404, r.status);
  r = await api('GET', '/slots');
  check('cancelled slot is available again', r.json.slots.find((s) => s.id === 's2').available === true);
  r = await book('s2', 'Rebooker', email('rebook'));
  check('cancelled slot can be booked again', r.status === 201, r);

  // ---------- Level 4 ----------
  console.log('\nLevel 4: idempotency and pagination');
  const idem = email('idem');
  const idemKey = `key-${run}-1`;
  const first = await book('s4', 'Ida Idem', idem, { 'Idempotency-Key': idemKey });
  const second = await book('s4', 'Ida Idem', idem, { 'Idempotency-Key': idemKey });
  check('first call 201', first.status === 201, first);
  check('same key + body -> same status and booking id',
    second.status === first.status && second.json && second.json.id === first.json.id, second);
  r = await book('s4', 'Different Name', idem, { 'Idempotency-Key': idemKey });
  check('same key, different body -> 422', r.status === 422 && typeof r.json.error === 'string', r);
  r = await api('GET', `/bookings?email=${encodeURIComponent(idem)}`);
  check('only one booking was created for the key', r.json && r.json.bookings.length === 1, r.json);

  const conKey = `key-${run}-2`;
  const con = await Promise.all(
    Array.from({ length: 5 }, () => book('s5', 'Concurrent Idem', email('conidem'), { 'Idempotency-Key': conKey }))
  );
  const ids = new Set(con.map((x) => x.json && x.json.id));
  check('5 simultaneous requests with one key -> same response',
    con.every((x) => x.status === 201) && ids.size === 1, con.map((x) => [x.status, x.json && x.json.id]));

  const pager = email('pager');
  for (const sid of ['s6', 's7', 's8', 's9']) {
    r = await book(sid, 'Paige Pager', pager);
    if (r.status !== 201) check(`setup booking ${sid}`, false, r);
  }
  const upper = pager.toUpperCase();
  r = await api('GET', `/bookings?email=${encodeURIComponent(upper)}&limit=3`);
  check('page 1 has 3 bookings, email match ignores case',
    r.status === 200 && r.json.bookings.length === 3 && !!r.json.next_cursor, r.json);
  const page1 = r.json.bookings.map((b) => b.id);
  r = await api('GET', `/bookings?email=${encodeURIComponent(pager)}&limit=3&cursor=${encodeURIComponent(r.json.next_cursor)}`);
  check('page 2 has the last booking and next_cursor null',
    r.status === 200 && r.json.bookings.length === 1 && r.json.next_cursor === null, r.json);
  const all = page1.concat(r.json.bookings.map((b) => b.id));
  check('no duplicates across pages', new Set(all).size === 4, all);
  r = await api('GET', `/bookings?email=${encodeURIComponent(pager)}`);
  const times = r.json.bookings.map((b) => b.created_at);
  check('default limit works and oldest first',
    r.status === 200 && r.json.bookings.length === 4 && times.join() === [...times].sort().join(), r.json);
  for (const bad of ['0', '51', 'abc', '-1']) {
    r = await api('GET', `/bookings?email=${encodeURIComponent(pager)}&limit=${bad}`);
    check(`limit=${bad} -> 400`, r.status === 400 && typeof r.json.error === 'string', r.status);
  }

  // ---------- Level 5 ----------
  console.log('\nLevel 5: rate limit');
  const spam = email('spam');
  const codes = [];
  for (let i = 0; i < 5; i++) {
    r = await book('nope', 'Spammer', spam); // failed attempts must count too
    codes.push(r.status);
  }
  check('first 5 attempts are not rate limited', codes.every((c) => c === 404), codes);
  r = await book('s10', 'Spammer', spam);
  const ra = r.headers.get('retry-after');
  check('6th attempt -> 429', r.status === 429 && typeof r.json.error === 'string', r);
  check('Retry-After is whole seconds (1-60)', /^\d+$/.test(ra || '') && +ra >= 1 && +ra <= 60, ra);
  r = await book('s10', 'Innocent', email('innocent'));
  check('other emails are not affected', r.status === 201, r);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error('Test run crashed:', e.message);
  process.exit(2);
});
