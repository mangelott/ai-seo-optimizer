// Integration tests against the real Express app, Postgres, and Redis.
// Requires `docker compose up -d` (see repo root) and the schema applied:
//   docker exec -i ai-seo-optimizer-postgres-1 psql -U user -d ai_seo_optimizer < db/schema.sql
// DataForSEO/Claude credentials are NOT required — these tests only exercise
// our own endpoints (auth, plan limits, quick-scan, billing), never the
// worker, so no external paid API is called.
require('dotenv').config();
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
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
    'TRUNCATE quick_scans, subscriptions, audits, monitored_domains, team_members, teams, users RESTART IDENTITY CASCADE'
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

test('google oauth: /google redirects to Google\'s consent screen with our client id and callback url', async () => {
  const res = await fetch(`${baseUrl}/api/auth/google?scanId=abc-123`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const location = res.headers.get('location');
  assert.match(location, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
  const params = new URL(location).searchParams;
  assert.equal(params.get('client_id'), process.env.GOOGLE_CLIENT_ID);
  assert.equal(params.get('redirect_uri'), process.env.GOOGLE_REDIRECT_URI);
  assert.equal(params.get('response_type'), 'code');
  assert.equal(params.get('state'), 'abc-123');
});

test('google oauth: callback without a code redirects back to login with an error, does not crash', async () => {
  const res = await fetch(`${baseUrl}/api/auth/google/callback`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.match(res.headers.get('location'), /\/login\?error=google_auth_failed$/);
});

test('password reset: forgot-password always returns ok and never reveals whether the email exists', async () => {
  const email = uniqueEmail('forgot');
  await registerAndLogin(email);

  const existing = await json('POST', '/api/auth/forgot-password', { body: { email } });
  assert.equal(existing.status, 200);
  assert.deepEqual(existing.data, { ok: true });

  const nonExistent = await json('POST', '/api/auth/forgot-password', {
    body: { email: uniqueEmail('never-registered') },
  });
  assert.equal(nonExistent.status, 200);
  assert.deepEqual(nonExistent.data, { ok: true });

  const row = await pool.query('SELECT reset_token_hash, reset_token_expires FROM users WHERE email = $1', [email]);
  assert.ok(row.rows[0].reset_token_hash, 'a reset token hash should have been stored');
  assert.ok(new Date(row.rows[0].reset_token_expires) > new Date(), 'expiry should be in the future');
});

test('password reset: a valid token lets you set a new password, exactly once', async () => {
  const email = uniqueEmail('reset');
  await registerAndLogin(email);

  const rawToken = 'test-raw-token-' + crypto.randomBytes(8).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    "UPDATE users SET reset_token_hash = $1, reset_token_expires = now() + interval '1 hour' WHERE email = $2",
    [tokenHash, email]
  );

  const reset = await json('POST', '/api/auth/reset-password', {
    body: { token: rawToken, newPassword: 'brandnewpassword123' },
  });
  assert.equal(reset.status, 200);

  const oldPasswordLogin = await json('POST', '/api/auth/login', { body: { email, password: 'password123' } });
  assert.equal(oldPasswordLogin.status, 401);

  const newPasswordLogin = await json('POST', '/api/auth/login', {
    body: { email, password: 'brandnewpassword123' },
  });
  assert.equal(newPasswordLogin.status, 200);

  const reuse = await json('POST', '/api/auth/reset-password', {
    body: { token: rawToken, newPassword: 'anotherpassword456' },
  });
  assert.equal(reuse.status, 400, 'a reset token must not be reusable');
});

test('password reset: expired or garbage tokens are rejected', async () => {
  const email = uniqueEmail('expired-reset');
  await registerAndLogin(email);

  const rawToken = 'expired-token-' + crypto.randomBytes(8).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
  await pool.query(
    "UPDATE users SET reset_token_hash = $1, reset_token_expires = now() - interval '1 hour' WHERE email = $2",
    [tokenHash, email]
  );

  const expired = await json('POST', '/api/auth/reset-password', {
    body: { token: rawToken, newPassword: 'irrelevant123' },
  });
  assert.equal(expired.status, 400);

  const garbage = await json('POST', '/api/auth/reset-password', {
    body: { token: 'this-token-was-never-issued', newPassword: 'irrelevant123' },
  });
  assert.equal(garbage.status, 400);
});

test('shareable report: toggling sharing exposes a public, read-only copy and hides it again on unshare', async () => {
  const token = await registerAndLogin(uniqueEmail('sharer'));
  const created = await json('POST', '/api/audit', { token, body: { domain: 'https://shareable-site.com' } });
  const auditId = created.data.auditId;

  const notSharedYet = await json('GET', `/api/audit/${auditId}`, { token });
  const publicBeforeShare = await json('GET', `/api/public/report/${notSharedYet.data.share_token}`);
  assert.equal(publicBeforeShare.status, 404, 'a report must not be public before it is explicitly shared');

  const shared = await json('PATCH', `/api/audit/${auditId}/share`, { token, body: { shared: true } });
  assert.equal(shared.status, 200);
  assert.equal(shared.data.is_shared, true);
  assert.ok(shared.data.share_token);

  const publicAfterShare = await json('GET', `/api/public/report/${shared.data.share_token}`);
  assert.equal(publicAfterShare.status, 200);
  assert.equal(publicAfterShare.data.domain, 'https://shareable-site.com');

  const unshared = await json('PATCH', `/api/audit/${auditId}/share`, { token, body: { shared: false } });
  assert.equal(unshared.data.is_shared, false);

  const publicAfterUnshare = await json('GET', `/api/public/report/${shared.data.share_token}`);
  assert.equal(publicAfterUnshare.status, 404, 'unsharing must revoke public access immediately');
});

test('shareable report: only the owner can toggle sharing', async () => {
  const ownerToken = await registerAndLogin(uniqueEmail('share-owner'));
  const created = await json('POST', '/api/audit', { token: ownerToken, body: { domain: 'https://someone-elses-site.com' } });

  const intruderToken = await registerAndLogin(uniqueEmail('share-intruder'));
  const stolen = await json('PATCH', `/api/audit/${created.data.auditId}/share`, {
    token: intruderToken,
    body: { shared: true },
  });
  assert.equal(stolen.status, 404);
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

test('recurring audits: enabling requires a valid interval and delivery preference', async () => {
  const token = await registerAndLogin(uniqueEmail('recurring-settings'));
  await json('POST', '/api/audit', { token, body: { domain: 'https://recurring-site.com' } });
  const [domain] = (await json('GET', '/api/domains', { token })).data;

  const missingInterval = await json('PATCH', `/api/domains/${domain.id}`, {
    token,
    body: { recurringEnabled: true, recurringDelivery: 'email' },
  });
  assert.equal(missingInterval.status, 400);

  const zeroInterval = await json('PATCH', `/api/domains/${domain.id}`, {
    token,
    body: { recurringEnabled: true, recurringIntervalDays: 0, recurringDelivery: 'email' },
  });
  assert.equal(zeroInterval.status, 400);

  const badDelivery = await json('PATCH', `/api/domains/${domain.id}`, {
    token,
    body: { recurringEnabled: true, recurringIntervalDays: 7, recurringDelivery: 'carrier_pigeon' },
  });
  assert.equal(badDelivery.status, 400);
});

test('recurring audits: enabling, updating, and disabling persist correctly and are owner-scoped', async () => {
  const token = await registerAndLogin(uniqueEmail('recurring-owner'));
  await json('POST', '/api/audit', { token, body: { domain: 'https://recurring-owner-site.com' } });
  const [domain] = (await json('GET', '/api/domains', { token })).data;

  const enabled = await json('PATCH', `/api/domains/${domain.id}`, {
    token,
    body: { recurringEnabled: true, recurringIntervalDays: 7, recurringDelivery: 'email' },
  });
  assert.equal(enabled.status, 200);
  assert.equal(enabled.data.recurring_enabled, true);
  assert.equal(enabled.data.recurring_interval_days, 7);
  assert.equal(enabled.data.recurring_delivery, 'email');

  const otherToken = await registerAndLogin(uniqueEmail('recurring-intruder'));
  const stolen = await json('PATCH', `/api/domains/${domain.id}`, {
    token: otherToken,
    body: { recurringEnabled: false },
  });
  assert.equal(stolen.status, 404, 'cannot update another user\'s recurring settings');

  const disabled = await json('PATCH', `/api/domains/${domain.id}`, {
    token,
    body: { recurringEnabled: false },
  });
  assert.equal(disabled.status, 200);
  assert.equal(disabled.data.recurring_enabled, false);
  assert.equal(disabled.data.recurring_interval_days, 7, 'disabling should not wipe the previously chosen interval');
});

test('google search console: status reflects connection, and disconnect clears it', async () => {
  const email = uniqueEmail('gsc-status');
  const token = await registerAndLogin(email);

  const before = await json('GET', '/api/gsc/status', { token });
  assert.equal(before.status, 200);
  assert.equal(before.data.connected, false);

  await pool.query(
    `UPDATE users SET gsc_access_token = 'fake-access', gsc_refresh_token = 'fake-refresh', gsc_connected_at = now()
     WHERE email = $1`,
    [email]
  );

  const after = await json('GET', '/api/gsc/status', { token });
  assert.equal(after.data.connected, true);

  const disconnect = await json('DELETE', '/api/gsc/disconnect', { token });
  assert.equal(disconnect.status, 200);

  const afterDisconnect = await json('GET', '/api/gsc/status', { token });
  assert.equal(afterDisconnect.data.connected, false);
});

test('google search console: /sites requires a connected account', async () => {
  const token = await registerAndLogin(uniqueEmail('gsc-sites'));
  const res = await json('GET', '/api/gsc/sites', { token });
  assert.equal(res.status, 400);
});

test('google search console: linking a site to a domain is owner-scoped', async () => {
  const token = await registerAndLogin(uniqueEmail('gsc-link'));
  await json('POST', '/api/audit', { token, body: { domain: 'https://gsc-linked-site.com' } });
  const [domain] = (await json('GET', '/api/domains', { token })).data;

  const linked = await json('PATCH', `/api/gsc/domains/${domain.id}`, {
    token,
    body: { siteUrl: 'https://gsc-linked-site.com/' },
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.gsc_site_url, 'https://gsc-linked-site.com/');

  const otherToken = await registerAndLogin(uniqueEmail('gsc-link-intruder'));
  const stolen = await json('PATCH', `/api/gsc/domains/${domain.id}`, {
    token: otherToken,
    body: { siteUrl: 'https://stolen.com/' },
  });
  assert.equal(stolen.status, 404);
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
