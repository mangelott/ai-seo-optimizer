// Integration tests against the real Express app, Postgres, and Redis.
// Requires `docker compose up -d` (see repo root) and the schema applied:
//   docker exec -i ai-seo-optimizer-postgres-1 psql -U user -d ai_seo_optimizer < db/schema.sql
// DataForSEO/Claude credentials are NOT required — these tests only exercise
// our own endpoints (auth, plan limits, quick-scan, billing), never the
// worker, so no external paid API is called.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection } = require('../jobs/queue');

let server;
let baseUrl;

async function json(method, path, { token, body } = {}) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    // some responses (e.g. webhooks) may not be JSON
  }
  return { status: res.status, data };
}

async function registerAndLogin(email, opts = {}) {
  await json('POST', '/api/auth/register', {
    body: { email, password: 'password123', ...opts },
  });
  const { data } = await json('POST', '/api/auth/login', {
    body: { email, password: 'password123' },
  });
  return data.token;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, users RESTART IDENTITY CASCADE'
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  redisConnection.disconnect();
});

test('GET /health returns ok', async () => {
  const { status, data } = await json('GET', '/health');
  assert.equal(status, 200);
  assert.deepEqual(data, { status: 'ok' });
});

test('auth: register, login, duplicate email, wrong password', async () => {
  const email = uniqueEmail('auth');

  const register = await json('POST', '/api/auth/register', {
    body: { name: 'Test User', email, password: 'password123' },
  });
  assert.equal(register.status, 201);
  assert.equal(register.data.email, email);
  assert.equal(register.data.name, 'Test User');

  const duplicate = await json('POST', '/api/auth/register', {
    body: { email, password: 'password123' },
  });
  assert.equal(duplicate.status, 409);

  const badLogin = await json('POST', '/api/auth/login', {
    body: { email, password: 'wrong-password' },
  });
  assert.equal(badLogin.status, 401);

  const goodLogin = await json('POST', '/api/auth/login', {
    body: { email, password: 'password123' },
  });
  assert.equal(goodLogin.status, 200);
  assert.ok(goodLogin.data.token);
});

test('auth: /me profile update and password change', async () => {
  const email = uniqueEmail('profile');
  const token = await registerAndLogin(email, { name: 'Original Name' });

  const me = await json('GET', '/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.equal(me.data.name, 'Original Name');
  assert.equal(me.data.plan, 'free');

  const updated = await json('PATCH', '/api/auth/me', { token, body: { name: 'New Name' } });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.name, 'New Name');

  const wrongCurrentPassword = await json('POST', '/api/auth/change-password', {
    token,
    body: { currentPassword: 'nope', newPassword: 'newpassword123' },
  });
  assert.equal(wrongCurrentPassword.status, 401);

  const changed = await json('POST', '/api/auth/change-password', {
    token,
    body: { currentPassword: 'password123', newPassword: 'newpassword123' },
  });
  assert.equal(changed.status, 200);

  const loginWithNewPassword = await json('POST', '/api/auth/login', {
    body: { email, password: 'newpassword123' },
  });
  assert.equal(loginWithNewPassword.status, 200);
});

test('endpoints requiring auth reject requests without a token', async () => {
  const me = await json('GET', '/api/auth/me');
  assert.equal(me.status, 401);

  const audits = await json('GET', '/api/audit');
  assert.equal(audits.status, 401);
});

test('plan limit: free plan allows exactly 1 full audit', async () => {
  const email = uniqueEmail('planlimit');
  const token = await registerAndLogin(email);

  const first = await json('POST', '/api/audit', { token, body: { domain: 'https://example.com' } });
  assert.equal(first.status, 202);
  assert.equal(first.data.status, 'pending');

  const second = await json('POST', '/api/audit', { token, body: { domain: 'https://another.com' } });
  assert.equal(second.status, 402);
  assert.match(second.data.error, /free audit/i);
});

test('plan limit: domain limit blocks a new domain but allows re-auditing an existing one', async () => {
  const email = uniqueEmail('domainlimit');
  const token = await registerAndLogin(email);
  await pool.query("UPDATE users SET plan = 'starter' WHERE email = $1", [email]);

  const firstDomain = await json('POST', '/api/audit', {
    token,
    body: { domain: 'https://first-domain.com' },
  });
  assert.equal(firstDomain.status, 202);

  const sameDomainAgain = await json('POST', '/api/audit', {
    token,
    body: { domain: 'https://first-domain.com' },
  });
  assert.equal(sameDomainAgain.status, 202, 'starter plan allows another audit of an already-audited domain');

  const secondDomain = await json('POST', '/api/audit', {
    token,
    body: { domain: 'https://second-domain.com' },
  });
  assert.equal(secondDomain.status, 402);
  assert.match(secondDomain.data.error, /1 domain/i);
});

test('audit: GET by id is scoped to the owning user', async () => {
  const ownerToken = await registerAndLogin(uniqueEmail('owner'));
  const created = await json('POST', '/api/audit', {
    token: ownerToken,
    body: { domain: 'https://owned-by-someone.com' },
  });
  assert.equal(created.status, 202);

  const otherToken = await registerAndLogin(uniqueEmail('intruder'));
  const stolen = await json('GET', `/api/audit/${created.data.auditId}`, { token: otherToken });
  assert.equal(stolen.status, 404);

  const own = await json('GET', `/api/audit/${created.data.auditId}`, { token: ownerToken });
  assert.equal(own.status, 200);
  assert.equal(own.data.domain, 'https://owned-by-someone.com');
});

test('quick-scan: anonymous scan, teaser stays locked, claim on register, only owner sees full result', async () => {
  const scan = await json('POST', '/api/quick-scan', { body: { domain: 'https://example.com' } });
  assert.equal(scan.status, 201);
  assert.ok(scan.data.scanId);
  assert.equal(typeof scan.data.score, 'number');
  assert.equal(typeof scan.data.issuesCount, 'number');

  const teaser = await json('GET', `/api/quick-scan/${scan.data.scanId}`);
  assert.equal(teaser.status, 200);
  assert.equal(teaser.data.claimed, false);

  const notFound = await json('GET', '/api/quick-scan/00000000-0000-0000-0000-000000000000');
  assert.equal(notFound.status, 404);

  const claimerEmail = uniqueEmail('claimer');
  const claimerToken = await registerAndLogin(claimerEmail, { scanId: scan.data.scanId });

  const teaserAfterClaim = await json('GET', `/api/quick-scan/${scan.data.scanId}`);
  assert.equal(teaserAfterClaim.data.claimed, true);

  const strangerToken = await registerAndLogin(uniqueEmail('stranger'));
  const stolenFull = await json('GET', `/api/quick-scan/${scan.data.scanId}/full`, { token: strangerToken });
  assert.equal(stolenFull.status, 403);

  const ownFull = await json('GET', `/api/quick-scan/${scan.data.scanId}/full`, { token: claimerToken });
  assert.equal(ownFull.status, 200);
  assert.ok(ownFull.data.content);
  assert.ok(Array.isArray(ownFull.data.issues));
});

test('billing summary: free plan reports usage against its lifetime limit, not a monthly one (regression for the "1 / 0" bug)', async () => {
  const email = uniqueEmail('billing');
  const token = await registerAndLogin(email);

  const before = await json('GET', '/api/billing/summary', { token });
  assert.equal(before.status, 200);
  assert.equal(before.data.plan, 'free');
  assert.equal(before.data.auditsThisMonth, 0);
  assert.equal(before.data.auditsLimit, 1);

  await json('POST', '/api/audit', { token, body: { domain: 'https://example.com' } });

  const after = await json('GET', '/api/billing/summary', { token });
  assert.equal(after.data.auditsThisMonth, 1);
  assert.equal(after.data.auditsLimit, 1);
  assert.notEqual(after.data.auditsLimit, 0, 'free plan must never report a 0 audit limit');
});

test('monitored domains: auditing a domain registers it, and removal really persists', async () => {
  const token = await registerAndLogin(uniqueEmail('domains'));

  const empty = await json('GET', '/api/domains', { token });
  assert.deepEqual(empty.data, []);

  await json('POST', '/api/audit', { token, body: { domain: 'https://tracked-site.com' } });

  const afterAudit = await json('GET', '/api/domains', { token });
  assert.equal(afterAudit.data.length, 1);
  assert.equal(afterAudit.data[0].domain, 'https://tracked-site.com');

  const otherToken = await registerAndLogin(uniqueEmail('domains-intruder'));
  const stolenDelete = await json('DELETE', `/api/domains/${afterAudit.data[0].id}`, { token: otherToken });
  assert.equal(stolenDelete.status, 404, 'cannot delete another user\'s monitored domain');

  const removed = await json('DELETE', `/api/domains/${afterAudit.data[0].id}`, { token });
  assert.equal(removed.status, 200);

  const afterRemoval = await json('GET', '/api/domains', { token });
  assert.deepEqual(afterRemoval.data, []);
});

test('account deletion cascades and revokes access', async () => {
  const email = uniqueEmail('deleteme');
  const token = await registerAndLogin(email);
  await json('POST', '/api/audit', { token, body: { domain: 'https://example.com' } });

  const del = await json('DELETE', '/api/auth/me', { token });
  assert.equal(del.status, 200);

  const meAfterDelete = await json('GET', '/api/auth/me', { token });
  assert.equal(meAfterDelete.status, 404);

  const loginAfterDelete = await json('POST', '/api/auth/login', {
    body: { email, password: 'password123' },
  });
  assert.equal(loginAfterDelete.status, 401);
});
