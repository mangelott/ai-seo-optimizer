// Integration tests for Agency API key access: creation is plan-gated,
// created keys authenticate POST /api/audit, GET /api/audit/:id and GET
// /api/domains exactly like a JWT session would, and a revoked key stops
// working immediately. No external paid API is called — POST /api/audit
// only enqueues a job (the worker never runs during `npm test`, see
// test.after below).
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const app = require('../app');
const pool = require('../db/pool');
const { connection: redisConnection, auditQueue } = require('../jobs/queue');

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
    // no body
  }
  return { status: res.status, data };
}

async function registerAndLogin(email) {
  await json('POST', '/api/auth/register', { body: { email, password: 'password123' } });
  const { data } = await json('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  return data.token;
}

function uniqueEmail(label) {
  return `${label}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function setPlan(email, plan) {
  await pool.query('UPDATE users SET plan = $1 WHERE email = $2', [plan, email]);
}

async function createAgencyKeyHolder(label) {
  const email = uniqueEmail(label);
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');
  const { status, data } = await json('POST', '/api/keys', { token, body: { name: 'CI key' } });
  return { email, token, keyRecordId: data.id, apiKey: data.key, createStatus: status };
}

test.before(async () => {
  await pool.query(
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, api_keys, users RESTART IDENTITY CASCADE'
  );
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://localhost:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
  await auditQueue.obliterate({ force: true });
  redisConnection.disconnect();
});

test('POST /api/keys requires the Agency plan', async () => {
  const email = uniqueEmail('key-free');
  const token = await registerAndLogin(email);

  const { status, data } = await json('POST', '/api/keys', { token, body: { name: 'My key' } });
  assert.equal(status, 402);
  assert.match(data.error, /Agency/);
});

test('POST /api/keys requires a name', async () => {
  const email = uniqueEmail('key-noname');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  const { status, data } = await json('POST', '/api/keys', { token, body: {} });
  assert.equal(status, 400);
  assert.match(data.error, /Name/);
});

test('Agency user can create, list and use an API key', async () => {
  const { createStatus, apiKey, token } = await createAgencyKeyHolder('key-agency');
  assert.equal(createStatus, 201);
  assert.match(apiKey, /^saeo_/);

  const { status: listStatus, data: keys } = await json('GET', '/api/keys', { token });
  assert.equal(listStatus, 200);
  assert.equal(keys.length, 1);
  assert.equal(keys[0].key_prefix, apiKey.slice(0, 12));
  assert.equal(keys[0].key, undefined);
  assert.equal(keys[0].revoked_at, null);

  const { status: auditStatus, data: auditData } = await json('POST', '/api/audit', {
    token: apiKey,
    body: { domain: 'example.com' },
  });
  assert.equal(auditStatus, 202);
  assert.ok(auditData.auditId);

  const { status: getStatus, data: audit } = await json('GET', `/api/audit/${auditData.auditId}`, {
    token: apiKey,
  });
  assert.equal(getStatus, 200);
  assert.equal(audit.domain, 'example.com');

  const { status: domainsStatus, data: domains } = await json('GET', '/api/domains', { token: apiKey });
  assert.equal(domainsStatus, 200);
  assert.ok(domains.some((d) => d.domain === 'example.com'));
});

test('A revoked API key is rejected', async () => {
  const { keyRecordId, apiKey, token } = await createAgencyKeyHolder('key-revoke');

  const { status: revokeStatus } = await json('DELETE', `/api/keys/${keyRecordId}`, { token });
  assert.equal(revokeStatus, 200);

  const { status } = await json('GET', '/api/domains', { token: apiKey });
  assert.equal(status, 401);

  // Revoking an already-revoked key is a 404, not a silent no-op.
  const { status: secondRevokeStatus } = await json('DELETE', `/api/keys/${keyRecordId}`, { token });
  assert.equal(secondRevokeStatus, 404);
});

test('An unrecognized bearer token is rejected on API-key-eligible routes', async () => {
  const { status: garbagePrefixed } = await json('GET', '/api/domains', { token: 'saeo_not-a-real-key' });
  assert.equal(garbagePrefixed, 401);

  const { status: garbageJwt } = await json('GET', '/api/domains', { token: 'not-a-jwt-either' });
  assert.equal(garbageJwt, 401);
});

test('GET /api/docs describes the API without requiring authentication', async () => {
  const { status, data } = await json('GET', '/api/docs');
  assert.equal(status, 200);
  assert.ok(data.endpoints.some((e) => e.path === '/api/audit' && e.method === 'POST'));
});
