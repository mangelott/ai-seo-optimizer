const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { sendTeamInviteEmail } = require('../services/email');

const router = express.Router();

async function getTeamForOwner(userId) {
  const result = await pool.query('SELECT * FROM teams WHERE owner_user_id = $1', [userId]);
  return result.rows[0];
}

router.get('/me', requireAuth, async (req, res) => {
  const userResult = await pool.query('SELECT team_id, plan FROM users WHERE id = $1', [req.user.id]);
  const { team_id: teamId } = userResult.rows[0];
  if (!teamId) return res.json({ team: null });

  const teamResult = await pool.query('SELECT * FROM teams WHERE id = $1', [teamId]);
  const team = teamResult.rows[0];
  if (!team) return res.json({ team: null });

  const membersResult = await pool.query(
    `SELECT tm.id, tm.invited_email, tm.role, tm.accepted_at, u.name AS user_name
     FROM team_members tm LEFT JOIN users u ON u.id = tm.user_id
     WHERE tm.team_id = $1 ORDER BY tm.created_at ASC`,
    [teamId]
  );

  res.json({
    team: { ...team, isOwner: team.owner_user_id === req.user.id },
    members: membersResult.rows,
  });
});

router.post('/', requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'Team name is required' });

  const userResult = await pool.query('SELECT plan, team_id FROM users WHERE id = $1', [req.user.id]);
  const user = userResult.rows[0];
  if (user.plan !== 'agency') {
    return res.status(402).json({ error: 'Creating a team requires the Agency plan' });
  }
  if (user.team_id) {
    return res.status(400).json({ error: 'You already belong to a team' });
  }

  const teamResult = await pool.query(
    'INSERT INTO teams (name, owner_user_id) VALUES ($1, $2) RETURNING *',
    [name, req.user.id]
  );
  const team = teamResult.rows[0];
  await pool.query('UPDATE users SET team_id = $1 WHERE id = $2', [team.id, req.user.id]);

  res.status(201).json({ team: { ...team, isOwner: true } });
});

router.patch('/', requireAuth, async (req, res) => {
  const { name, whiteLabelLogoUrl, whiteLabelBrandColor } = req.body;
  const team = await getTeamForOwner(req.user.id);
  if (!team) return res.status(404).json({ error: 'You do not own a team' });

  const result = await pool.query(
    `UPDATE teams SET name = COALESCE($1, name),
     white_label_logo_url = $2, white_label_brand_color = $3
     WHERE id = $4 RETURNING *`,
    [name ?? null, whiteLabelLogoUrl ?? null, whiteLabelBrandColor ?? null, team.id]
  );
  res.json({ team: { ...result.rows[0], isOwner: true } });
});

router.post('/invite', requireAuth, async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });

  const team = await getTeamForOwner(req.user.id);
  if (!team) return res.status(404).json({ error: 'You do not own a team' });

  const inserted = await pool.query(
    `INSERT INTO team_members (team_id, invited_email) VALUES ($1, $2)
     ON CONFLICT (team_id, invited_email) DO NOTHING
     RETURNING id`,
    [team.id, email]
  );
  if (!inserted.rows[0]) {
    return res.status(409).json({ error: 'That email has already been invited' });
  }

  // If they already have an account and no team of their own, link them up right away.
  const existingUser = await pool.query('SELECT id, team_id FROM users WHERE email = $1', [email]);
  if (existingUser.rows[0] && !existingUser.rows[0].team_id) {
    await pool.query(
      'UPDATE team_members SET user_id = $1, accepted_at = now() WHERE team_id = $2 AND invited_email = $3',
      [existingUser.rows[0].id, team.id, email]
    );
    await pool.query('UPDATE users SET team_id = $1 WHERE id = $2', [team.id, existingUser.rows[0].id]);
  }

  const inviter = await pool.query('SELECT email FROM users WHERE id = $1', [req.user.id]);
  try {
    await sendTeamInviteEmail(email, {
      teamName: team.name,
      inviterEmail: inviter.rows[0].email,
      appUrl: process.env.FRONTEND_URL,
    });
  } catch (err) {
    console.error('Failed to send team invite email:', err.message);
  }

  res.status(201).json({ ok: true });
});

router.delete('/members/:id', requireAuth, async (req, res) => {
  const team = await getTeamForOwner(req.user.id);
  if (!team) return res.status(404).json({ error: 'You do not own a team' });

  const memberResult = await pool.query(
    'SELECT user_id FROM team_members WHERE id = $1 AND team_id = $2',
    [req.params.id, team.id]
  );
  if (!memberResult.rows[0]) return res.status(404).json({ error: 'Member not found' });

  await pool.query('DELETE FROM team_members WHERE id = $1', [req.params.id]);
  if (memberResult.rows[0].user_id) {
    await pool.query('UPDATE users SET team_id = NULL WHERE id = $1 AND team_id = $2', [
      memberResult.rows[0].user_id,
      team.id,
    ]);
  }

  res.json({ ok: true });
});

router.delete('/', requireAuth, async (req, res) => {
  const team = await getTeamForOwner(req.user.id);
  if (!team) return res.status(404).json({ error: 'You do not own a team' });

  await pool.query('UPDATE users SET team_id = NULL WHERE team_id = $1', [team.id]);
  await pool.query('DELETE FROM teams WHERE id = $1', [team.id]);

  res.json({ ok: true });
});

module.exports = router;
