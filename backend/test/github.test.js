// Integration tests for GitHub auto-fix: connecting the App installation,
// linking a repo to a domain, and applying a fix end-to-end (code search →
// file read → branch → commit → PR) against a fake GitHub REST API server,
// so the real request-building logic in services/github.js is exercised —
// not just stubbed. GITHUB_API_BASE_URL must be set before services/github.js
// (or anything that requires it) is first loaded, so it's set at the very top.
require('dotenv').config();
process.env.GITHUB_APP_ID = process.env.GITHUB_APP_ID || '123456';
process.env.GITHUB_APP_PRIVATE_KEY = process.env.GITHUB_APP_PRIVATE_KEY || '';

const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

const FAKE_INSTALLATION_TOKEN = 'fake-installation-token';
const FAKE_REPO = 'acme/website';

let fakeGithubServer;
let app;
let pool;
let redisConnection;
let server;
let baseUrl;

function requireInstallToken(req, res, next) {
  if (req.headers.authorization !== `token ${FAKE_INSTALLATION_TOKEN}`) {
    return res.status(401).json({ message: 'Bad credentials' });
  }
  next();
}

function buildFakeGithubApp() {
  const gh = express();
  gh.use(express.json());

  gh.post('/app/installations/:id/access_tokens', (req, res) => {
    if (!req.headers.authorization?.startsWith('Bearer ')) return res.status(401).json({ message: 'Bad credentials' });
    res.json({ token: FAKE_INSTALLATION_TOKEN, expires_at: new Date(Date.now() + 3600 * 1000).toISOString() });
  });

  gh.get('/installation/repositories', requireInstallToken, (req, res) => {
    res.json({ repositories: [{ full_name: FAKE_REPO, default_branch: 'main' }] });
  });

  const FILES = {
    'src/pages/unique.html': '<html><head><title>UNIQUE_TEXT</title></head></html>',
    'src/pages/index.html': '<html><head><title>Old Title</title></head></html>',
    'src/pages/about.html': '<html><head><title>Old Title</title></head></html>',
    'src/pages/duplicate.html': '<p>DUPLICATE_TEXT</p><p>DUPLICATE_TEXT</p>',
  };

  gh.get('/search/code', requireInstallToken, (req, res) => {
    const q = String(req.query.q || '');
    if (q.includes('UNIQUE_TEXT')) return res.json({ items: [{ path: 'src/pages/unique.html' }] });
    if (q.includes('Old Title')) {
      return res.json({ items: [{ path: 'src/pages/index.html' }, { path: 'src/pages/about.html' }] });
    }
    if (q.includes('DUPLICATE_TEXT')) return res.json({ items: [{ path: 'src/pages/duplicate.html' }] });
    res.json({ items: [] });
  });

  gh.get('/repos/:owner/:repo/contents/*splat', requireInstallToken, (req, res) => {
    const path = req.params.splat.join('/');
    const content = FILES[path];
    if (content == null) return res.status(404).json({ message: 'Not Found' });
    res.json({ content: Buffer.from(content).toString('base64'), sha: `sha-${path}` });
  });

  gh.get('/repos/:owner/:repo/git/ref/heads/:branch', requireInstallToken, (req, res) => {
    res.json({ object: { sha: 'fake-base-sha' } });
  });

  gh.post('/repos/:owner/:repo/git/refs', requireInstallToken, (req, res) => {
    res.status(201).json({ ref: req.body.ref, object: { sha: req.body.sha } });
  });

  gh.put('/repos/:owner/:repo/contents/*splat', requireInstallToken, (req, res) => {
    res.json({ content: { sha: 'new-sha' }, commit: { sha: 'commit-sha' } });
  });

  gh.post('/repos/:owner/:repo/pulls', requireInstallToken, (req, res) => {
    res.status(201).json({ html_url: `https://github.com/${FAKE_REPO}/pull/42`, number: 42 });
  });

  return gh;
}

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

async function connectGithub(userId) {
  await pool.query('UPDATE users SET github_installation_id = $1 WHERE id = $2', ['99887766', userId]);
}

async function setupAuditedDomain(label, domain) {
  const token = await registerAndLogin(uniqueEmail(label));
  const created = await json('POST', '/api/audit', { token, body: { domain } });
  const domainsRes = await json('GET', '/api/domains', { token });
  return { token, auditId: created.data.auditId, domainRow: domainsRes.data[0] };
}

test.before(async () => {
  await new Promise((resolve) => {
    fakeGithubServer = buildFakeGithubApp().listen(0, resolve);
  });
  process.env.GITHUB_API_BASE_URL = `http://localhost:${fakeGithubServer.address().port}`;

  // Required only after GITHUB_API_BASE_URL is set, so services/github.js picks it up.
  app = require('../app');
  pool = require('../db/pool');
  ({ connection: redisConnection } = require('../jobs/queue'));

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
  await new Promise((resolve) => fakeGithubServer.close(resolve));
  await pool.end();
  redisConnection.disconnect();
});

test('github: status reflects the connection, and disconnect clears it', async () => {
  const email = uniqueEmail('gh-status');
  const token = await registerAndLogin(email);

  const before = await json('GET', '/api/github/status', { token });
  assert.equal(before.data.connected, false);

  const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  await connectGithub(userRow.rows[0].id);

  const after = await json('GET', '/api/github/status', { token });
  assert.equal(after.data.connected, true);

  const disconnect = await json('DELETE', '/api/github/disconnect', { token });
  assert.equal(disconnect.status, 200);
  const afterDisconnect = await json('GET', '/api/github/status', { token });
  assert.equal(afterDisconnect.data.connected, false);
});

test('github: /repos requires a connected installation and lists what the fake API returns', async () => {
  const email = uniqueEmail('gh-repos');
  const token = await registerAndLogin(email);

  const blocked = await json('GET', '/api/github/repos', { token });
  assert.equal(blocked.status, 400);

  const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  await connectGithub(userRow.rows[0].id);

  const repos = await json('GET', '/api/github/repos', { token });
  assert.equal(repos.status, 200);
  assert.deepEqual(repos.data, [{ fullName: FAKE_REPO, defaultBranch: 'main' }]);
});

test('github: linking a repo to a domain is owner-scoped', async () => {
  const { token, domainRow } = await setupAuditedDomain('gh-link', 'https://gh-link-site.com');
  const linked = await json('PATCH', `/api/github/domains/${domainRow.id}`, {
    token,
    body: { repo: FAKE_REPO, branch: 'main' },
  });
  assert.equal(linked.status, 200);
  assert.equal(linked.data.github_repo, FAKE_REPO);

  const intruderToken = await registerAndLogin(uniqueEmail('gh-link-intruder'));
  const stolen = await json('PATCH', `/api/github/domains/${domainRow.id}`, {
    token: intruderToken,
    body: { repo: 'evil/repo', branch: 'main' },
  });
  assert.equal(stolen.status, 404);
});

test('github: applying a fix end-to-end opens a PR when the search finds a unique file', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('gh-happy', 'https://gh-happy-site.com');
  const userRow = await pool.query(
    'SELECT id FROM users WHERE id = (SELECT user_id FROM monitored_domains WHERE id = $1)',
    [domainRow.id]
  );
  await connectGithub(userRow.rows[0].id);
  await json('PATCH', `/api/github/domains/${domainRow.id}`, { token, body: { repo: FAKE_REPO, branch: 'main' } });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      {
        category: 'technical',
        severity: 'high',
        title: 'Missing unique title',
        sourceSearchText: 'UNIQUE_TEXT',
        sourceReplaceText: 'UNIQUE_TEXT_REPLACED',
      },
    ]),
    auditId,
  ]);

  const applied = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(applied.status, 200);
  assert.equal(applied.data.fix.prUrl, `https://github.com/${FAKE_REPO}/pull/42`);
  assert.equal(applied.data.fix.prNumber, 42);
  assert.equal(applied.data.fix.appliedVia, 'github');
  assert.equal(applied.data.fix.applied, undefined, 'GitHub fixes use prUrl, not the WordPress-style applied flag');

  const auditRow = await pool.query('SELECT ai_recommendations FROM audits WHERE id = $1', [auditId]);
  assert.equal(auditRow.rows[0].ai_recommendations[0].prUrl, `https://github.com/${FAKE_REPO}/pull/42`);
});

test('github: an ambiguous search (text found in multiple files) returns 409 with candidates, and a manual filePath resolves it', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('gh-ambiguous', 'https://gh-ambiguous-site.com');
  const userRow = await pool.query(
    'SELECT id FROM users WHERE id = (SELECT user_id FROM monitored_domains WHERE id = $1)',
    [domainRow.id]
  );
  await connectGithub(userRow.rows[0].id);
  await json('PATCH', `/api/github/domains/${domainRow.id}`, { token, body: { repo: FAKE_REPO, branch: 'main' } });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      {
        category: 'content',
        severity: 'high',
        title: 'Duplicate title tag',
        sourceSearchText: 'Old Title',
        sourceReplaceText: 'New Title',
      },
    ]),
    auditId,
  ]);

  const ambiguous = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(ambiguous.status, 409);
  assert.deepEqual(ambiguous.data.candidates.sort(), ['src/pages/about.html', 'src/pages/index.html']);

  const resolved = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, {
    token,
    body: { filePath: 'src/pages/about.html' },
  });
  assert.equal(resolved.status, 200);
  assert.equal(resolved.data.fix.prUrl, `https://github.com/${FAKE_REPO}/pull/42`);
});

test('github: text appearing more than once in the resolved file is rejected as unsafe (occurrence-count guard)', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('gh-duplicate', 'https://gh-duplicate-site.com');
  const userRow = await pool.query(
    'SELECT id FROM users WHERE id = (SELECT user_id FROM monitored_domains WHERE id = $1)',
    [domainRow.id]
  );
  await connectGithub(userRow.rows[0].id);
  await json('PATCH', `/api/github/domains/${domainRow.id}`, { token, body: { repo: FAKE_REPO, branch: 'main' } });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      {
        category: 'content',
        severity: 'medium',
        title: 'Duplicate text',
        sourceSearchText: 'DUPLICATE_TEXT',
        sourceReplaceText: 'FIXED_TEXT',
      },
    ]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 409);
  assert.deepEqual(res.data.candidates, []);
});

test('github: a search with zero matches returns 409 with empty candidates', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('gh-notfound', 'https://gh-notfound-site.com');
  const userRow = await pool.query(
    'SELECT id FROM users WHERE id = (SELECT user_id FROM monitored_domains WHERE id = $1)',
    [domainRow.id]
  );
  await connectGithub(userRow.rows[0].id);
  await json('PATCH', `/api/github/domains/${domainRow.id}`, { token, body: { repo: FAKE_REPO, branch: 'main' } });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      {
        category: 'content',
        severity: 'low',
        title: 'Nothing to find',
        sourceSearchText: 'TEXT_THAT_DOES_NOT_EXIST_ANYWHERE',
        sourceReplaceText: 'x',
      },
    ]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 409);
  assert.deepEqual(res.data.candidates, []);
});

test('github: a fix without sourceSearchText/sourceReplaceText cannot be auto-applied via GitHub', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('gh-nofield', 'https://gh-nofield-site.com');
  const userRow = await pool.query(
    'SELECT id FROM users WHERE id = (SELECT user_id FROM monitored_domains WHERE id = $1)',
    [domainRow.id]
  );
  await connectGithub(userRow.rows[0].id);
  await json('PATCH', `/api/github/domains/${domainRow.id}`, { token, body: { repo: FAKE_REPO, branch: 'main' } });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([{ category: 'keywords', severity: 'low', title: 'Add more backlinks', sourceSearchText: null }]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 400);
});

test('github: applying is blocked when no domain connection (WordPress or GitHub) exists at all', async () => {
  const { token, auditId } = await setupAuditedDomain('gh-noconn', 'https://gh-noconn-site.com');
  const domainsRes = await json('GET', '/api/domains', { token });
  await json('PATCH', `/api/wordpress/domains/${domainsRes.data[0].id}/toggle`, {
    token,
    body: { autoFixEnabled: true },
  });
  // auto_fix_enabled is on, but nothing is actually connected.

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      { category: 'content', severity: 'high', title: 'x', sourceSearchText: 'a', sourceReplaceText: 'b' },
    ]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 400);
});

test('github: WordPress takes priority over GitHub when both happen to be linked on the same domain', async () => {
  const { token, auditId, domainRow } = await setupAuditedDomain('gh-priority', 'https://gh-priority-site.com');
  const userRow = await pool.query(
    'SELECT id FROM users WHERE id = (SELECT user_id FROM monitored_domains WHERE id = $1)',
    [domainRow.id]
  );
  await connectGithub(userRow.rows[0].id);
  await json('PATCH', `/api/github/domains/${domainRow.id}`, { token, body: { repo: FAKE_REPO, branch: 'main' } });
  await json('PATCH', `/api/wordpress/domains/${domainRow.id}/toggle`, { token, body: { autoFixEnabled: true } });
  // Directly set wp_url in the DB to simulate both being connected (UI wouldn't normally allow this).
  await pool.query('UPDATE monitored_domains SET wp_url = $1 WHERE id = $2', ['https://gh-priority-site.com', domainRow.id]);

  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [
    JSON.stringify([
      {
        category: 'content',
        severity: 'high',
        title: 'x',
        wpField: null, // no WP mapping, so the WP path should reject it (proving WP was actually chosen)
        sourceSearchText: 'UNIQUE_TEXT',
        sourceReplaceText: 'y',
      },
    ]),
    auditId,
  ]);

  const res = await json('POST', `/api/audit/${auditId}/fixes/0/apply`, { token });
  assert.equal(res.status, 400);
  assert.match(res.data.error, /WordPress/);
});
