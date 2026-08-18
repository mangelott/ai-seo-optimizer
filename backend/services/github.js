const axios = require('axios');
const jwt = require('jsonwebtoken');

// Overridable so integration tests can point this at a local fake GitHub API
// instead of stubbing every method — exercises the real request-building code.
const GITHUB_API = process.env.GITHUB_API_BASE_URL || 'https://api.github.com';

function signAppJwt() {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    { iat: now - 60, exp: now + 9 * 60, iss: process.env.GITHUB_APP_ID },
    (process.env.GITHUB_APP_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
    { algorithm: 'RS256' }
  );
}

async function createInstallationToken(installationId) {
  const appJwt = signAppJwt();
  const { data } = await axios.post(
    `${GITHUB_API}/app/installations/${installationId}/access_tokens`,
    {},
    { headers: { Authorization: `Bearer ${appJwt}`, Accept: 'application/vnd.github+json' } }
  );
  return data.token;
}

function authHeaders(token) {
  return { Authorization: `token ${token}`, Accept: 'application/vnd.github+json' };
}

// Encode each path segment individually (not the whole path) so nested
// directories keep their literal "/" — encodeURIComponent on the full path
// would turn every "/" into "%2F", which GitHub's contents API rejects.
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

async function listInstallationRepos(installationId) {
  const token = await createInstallationToken(installationId);
  const { data } = await axios.get(`${GITHUB_API}/installation/repositories`, { headers: authHeaders(token) });
  return (data.repositories || []).map((r) => ({ fullName: r.full_name, defaultBranch: r.default_branch }));
}

async function searchCode(installationId, repoFullName, query) {
  const token = await createInstallationToken(installationId);
  const { data } = await axios.get(`${GITHUB_API}/search/code`, {
    headers: authHeaders(token),
    params: { q: `${query} repo:${repoFullName}` },
  });
  return (data.items || []).map((item) => item.path);
}

async function getFile(installationId, repoFullName, path, branch) {
  const token = await createInstallationToken(installationId);
  const { data } = await axios.get(
    `${GITHUB_API}/repos/${repoFullName}/contents/${encodePath(path)}`,
    { headers: authHeaders(token), params: { ref: branch } }
  );
  return { content: Buffer.from(data.content, 'base64').toString('utf8'), sha: data.sha };
}

async function getBranchSha(installationId, repoFullName, branch) {
  const token = await createInstallationToken(installationId);
  const { data } = await axios.get(`${GITHUB_API}/repos/${repoFullName}/git/ref/heads/${branch}`, {
    headers: authHeaders(token),
  });
  return data.object.sha;
}

async function createBranch(installationId, repoFullName, newBranch, fromSha) {
  const token = await createInstallationToken(installationId);
  await axios.post(
    `${GITHUB_API}/repos/${repoFullName}/git/refs`,
    { ref: `refs/heads/${newBranch}`, sha: fromSha },
    { headers: authHeaders(token) }
  );
}

async function updateFile(installationId, repoFullName, path, { content, sha, branch, message }) {
  const token = await createInstallationToken(installationId);
  await axios.put(
    `${GITHUB_API}/repos/${repoFullName}/contents/${encodePath(path)}`,
    { message, content: Buffer.from(content, 'utf8').toString('base64'), sha, branch },
    { headers: authHeaders(token) }
  );
}

async function createPullRequest(installationId, repoFullName, { title, head, base, body }) {
  const token = await createInstallationToken(installationId);
  const { data } = await axios.post(
    `${GITHUB_API}/repos/${repoFullName}/pulls`,
    { title, head, base, body },
    { headers: authHeaders(token) }
  );
  return { url: data.html_url, number: data.number };
}

module.exports = {
  signAppJwt,
  createInstallationToken,
  listInstallationRepos,
  searchCode,
  getFile,
  getBranchSha,
  createBranch,
  updateFile,
  createPullRequest,
};
