// Integration tests for team accounts: creation (Agency-plan gated), invites
// (including auto-accept for existing and future accounts), shared audit/domain
// visibility, and white-label settings.
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

test('teams: creating a team requires the Agency plan', async () => {
  const email = uniqueEmail('team-free');
  const token = await registerAndLogin(email);

  const blocked = await json('POST', '/api/teams', { token, body: { name: 'My Agency' } });
  assert.equal(blocked.status, 402);

  await setPlan(email, 'agency');
  const allowed = await json('POST', '/api/teams', { token, body: { name: 'My Agency' } });
  assert.equal(allowed.status, 201);
  assert.equal(allowed.data.team.name, 'My Agency');
  assert.equal(allowed.data.team.isOwner, true);
});

test('teams: a user can only own one team', async () => {
  const email = uniqueEmail('team-double');
  const token = await registerAndLogin(email);
  await setPlan(email, 'agency');

  await json('POST', '/api/teams', { token, body: { name: 'First' } });
  const second = await json('POST', '/api/teams', { token, body: { name: 'Second' } });
  assert.equal(second.status, 400);
});

test('teams: inviting an existing user links them immediately; a future signup auto-joins', async () => {
  const ownerEmail = uniqueEmail('team-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'Agency Co' } });

  // Existing account: invited and linked in the same call.
  const existingMemberEmail = uniqueEmail('team-existing-member');
  await registerAndLogin(existingMemberEmail);
  const invite1 = await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: existingMemberEmail } });
  assert.equal(invite1.status, 201);

  const memberSelf = await json('GET', '/api/teams/me', { token: await registerAndLogin(existingMemberEmail) });
  assert.equal(memberSelf.data.team.name, 'Agency Co');
  assert.equal(memberSelf.data.team.isOwner, false);

  // Not-yet-registered email: invited now, auto-joins on first register.
  const futureMemberEmail = uniqueEmail('team-future-member');
  const invite2 = await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: futureMemberEmail } });
  assert.equal(invite2.status, 201);

  const futureToken = await registerAndLogin(futureMemberEmail);
  const futureSelf = await json('GET', '/api/teams/me', { token: futureToken });
  assert.equal(futureSelf.data.team.name, 'Agency Co');
});

test('teams: inviting the same email twice is rejected', async () => {
  const ownerEmail = uniqueEmail('team-dupinvite-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'DupCo' } });

  const targetEmail = uniqueEmail('team-dupinvite-target');
  const first = await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: targetEmail } });
  assert.equal(first.status, 201);
  const second = await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: targetEmail } });
  assert.equal(second.status, 409);
});

test('teams: only the owner can invite, update white-label settings, or delete the team', async () => {
  const ownerEmail = uniqueEmail('team-perms-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'PermsCo' } });

  const memberEmail = uniqueEmail('team-perms-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  const memberInvite = await json('POST', '/api/teams/invite', { token: memberToken, body: { email: uniqueEmail('x') } });
  assert.equal(memberInvite.status, 404);

  const memberPatch = await json('PATCH', '/api/teams', { token: memberToken, body: { whiteLabelBrandColor: '#000' } });
  assert.equal(memberPatch.status, 404);

  const memberDelete = await json('DELETE', '/api/teams', { token: memberToken });
  assert.equal(memberDelete.status, 404);
});

test('teams: owner can update white-label branding', async () => {
  const ownerEmail = uniqueEmail('team-brand-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'BrandCo' } });

  const updated = await json('PATCH', '/api/teams', {
    token: ownerToken,
    body: { whiteLabelLogoUrl: 'https://example.com/logo.png', whiteLabelBrandColor: '#ff0000' },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.data.team.white_label_logo_url, 'https://example.com/logo.png');
  assert.equal(updated.data.team.white_label_brand_color, '#ff0000');
});

test('teams: audits and domains are visible to every team member, not just the creator', async () => {
  const ownerEmail = uniqueEmail('team-share-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'ShareCo' } });
  await json('POST', '/api/audit', { token: ownerToken, body: { domain: 'https://owner-site.com' } });

  const memberEmail = uniqueEmail('team-share-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  const memberAudits = await json('GET', '/api/audit', { token: memberToken });
  assert.ok(memberAudits.data.some((a) => a.domain === 'https://owner-site.com'));

  const memberDomains = await json('GET', '/api/domains', { token: memberToken });
  assert.ok(memberDomains.data.some((d) => d.domain === 'https://owner-site.com'));

  // An unrelated outsider must not see any of this.
  const outsiderToken = await registerAndLogin(uniqueEmail('team-share-outsider'));
  const outsiderAudits = await json('GET', '/api/audit', { token: outsiderToken });
  assert.ok(!outsiderAudits.data.some((a) => a.domain === 'https://owner-site.com'));
});

test('teams: removing a member frees them to join or create another team', async () => {
  const ownerEmail = uniqueEmail('team-remove-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'RemoveCo' } });

  const memberEmail = uniqueEmail('team-remove-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });

  const membersBefore = await json('GET', '/api/teams/me', { token: ownerToken });
  const memberRow = membersBefore.data.members.find((m) => m.invited_email === memberEmail);
  assert.ok(memberRow);

  const removed = await json('DELETE', `/api/teams/members/${memberRow.id}`, { token: ownerToken });
  assert.equal(removed.status, 200);

  const memberToken = await registerAndLogin(memberEmail);
  const memberSelf = await json('GET', '/api/teams/me', { token: memberToken });
  assert.equal(memberSelf.data.team, null);
});

test('teams: deleting a team frees every member', async () => {
  const ownerEmail = uniqueEmail('team-delete-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'DeleteCo' } });

  const memberEmail = uniqueEmail('team-delete-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  const del = await json('DELETE', '/api/teams', { token: ownerToken });
  assert.equal(del.status, 200);

  const ownerSelf = await json('GET', '/api/teams/me', { token: ownerToken });
  assert.equal(ownerSelf.data.team, null);
  const memberSelf = await json('GET', '/api/teams/me', { token: memberToken });
  assert.equal(memberSelf.data.team, null);
});

test('teams: a member on their own free plan inherits the team owner\'s unlimited Agency limits', async () => {
  const ownerEmail = uniqueEmail('team-inherit-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'InheritCo' } });

  const memberEmail = uniqueEmail('team-inherit-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  // Member is still nominally "free" but should not be capped at 1 lifetime audit.
  for (let i = 0; i < 3; i++) {
    const res = await json('POST', '/api/audit', { token: memberToken, body: { domain: `https://member-site-${i}.com` } });
    assert.equal(res.status, 202, `audit ${i} should not be blocked by the free-plan limit`);
  }
});

test('teams: deleting the owner\'s account tears down the team and frees every member (regression)', async () => {
  const ownerEmail = uniqueEmail('team-owner-del-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'OwnerDelCo' } });

  const memberEmail = uniqueEmail('team-owner-del-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  const memberBefore = await json('GET', '/api/teams/me', { token: memberToken });
  assert.equal(memberBefore.data.team.name, 'OwnerDelCo');

  const del = await json('DELETE', '/api/auth/me', { token: ownerToken });
  assert.equal(del.status, 200);

  // The DB-level FK (ON DELETE SET NULL) must have cleared the member's
  // team_id when the owner's deletion cascaded the team away — not just the
  // team_members row. Check the raw column directly, not only the API view.
  const memberRow = await pool.query('SELECT team_id FROM users WHERE email = $1', [memberEmail]);
  assert.equal(memberRow.rows[0].team_id, null, 'team_id must not be left dangling after the owning team disappears');

  const memberAfter = await json('GET', '/api/teams/me', { token: memberToken });
  assert.equal(memberAfter.data.team, null);
});

test('teams: a member freed by owner-deletion can actually join a new team afterwards (regression)', async () => {
  // This is the real bite of the orphaned-team_id bug: acceptPendingTeamInvites
  // and the invite auto-link both gate on "team_id IS NULL". If the FK cleanup
  // above didn't run, this member would be permanently stuck.
  const ownerEmail = uniqueEmail('team-rejoin-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'OldCo' } });

  const memberEmail = uniqueEmail('team-rejoin-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  await registerAndLogin(memberEmail); // accept

  await json('DELETE', '/api/auth/me', { token: ownerToken });

  const newOwnerEmail = uniqueEmail('team-rejoin-newowner');
  const newOwnerToken = await registerAndLogin(newOwnerEmail);
  await setPlan(newOwnerEmail, 'agency');
  await json('POST', '/api/teams', { token: newOwnerToken, body: { name: 'NewCo' } });

  const invite = await json('POST', '/api/teams/invite', { token: newOwnerToken, body: { email: memberEmail } });
  assert.equal(invite.status, 201);

  // Existing account with a (now-cleared) null team_id: should auto-link immediately.
  const memberSelf = await json('GET', '/api/teams/me', { token: await registerAndLogin(memberEmail) });
  assert.equal(memberSelf.data.team?.name, 'NewCo', 'a previously-orphaned member must be able to join a new team');
});

test('teams: a non-owner member deleting their own account does not affect the team or other members', async () => {
  const ownerEmail = uniqueEmail('team-memberdel-owner');
  const ownerToken = await registerAndLogin(ownerEmail);
  await setPlan(ownerEmail, 'agency');
  await json('POST', '/api/teams', { token: ownerToken, body: { name: 'MemberDelCo' } });

  const memberEmail = uniqueEmail('team-memberdel-member');
  await registerAndLogin(memberEmail);
  await json('POST', '/api/teams/invite', { token: ownerToken, body: { email: memberEmail } });
  const memberToken = await registerAndLogin(memberEmail);

  const del = await json('DELETE', '/api/auth/me', { token: memberToken });
  assert.equal(del.status, 200);

  const ownerSelf = await json('GET', '/api/teams/me', { token: ownerToken });
  assert.equal(ownerSelf.data.team.name, 'MemberDelCo');
});
