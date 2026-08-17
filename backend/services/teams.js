const pool = require('../db/pool');

// Called after register/login: if this email has a pending invite and the
// user isn't already on a team, link them up automatically.
async function acceptPendingTeamInvites(userId, email) {
  const pending = await pool.query(
    'SELECT team_id FROM team_members WHERE invited_email = $1 AND accepted_at IS NULL LIMIT 1',
    [email]
  );
  if (!pending.rows[0]) return;

  const teamId = pending.rows[0].team_id;
  await pool.query(
    'UPDATE team_members SET user_id = $1, accepted_at = now() WHERE team_id = $2 AND invited_email = $3',
    [userId, teamId, email]
  );
  await pool.query('UPDATE users SET team_id = $1 WHERE id = $2 AND team_id IS NULL', [teamId, userId]);
}

module.exports = { acceptPendingTeamInvites };
