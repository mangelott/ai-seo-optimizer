const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { sendTeamInviteEmail } = require('../services/email');
const { SCORE_DROP_ALERT_THRESHOLD } = require('../services/auditProcessor');

const router = express.Router();

async function getTeamForOwner(userId) {
  const result = await pool.query('SELECT * FROM teams WHERE owner_user_id = $1', [userId]);
  return result.rows[0];
}

// Portfolio: one row per domain visible to the caller (their own domains, or
// the whole team's if they're on one — same visibility subquery as GET
// /api/domains and GET /api/audit), with the latest audit score, the trend
// vs the previous audit for that domain, and any active alerts. There's no
// persisted "alerts" concept in this codebase yet (see auditProcessor.js's
// SCORE_DROP_ALERT_THRESHOLD, which only ever fires a one-off email) — this
// recomputes the same score-drop check live from the latest two audits
// instead of introducing a new alerts table for a single alert type.
router.get('/portfolio', requireAuth, async (req, res) => {
  const result = await pool.query(
    `WITH visible_domains AS (
       SELECT DISTINCT domain FROM monitored_domains
       WHERE user_id IN (SELECT id FROM users WHERE id = $1 OR team_id = (SELECT team_id FROM users WHERE id = $1))
     ),
     ranked_audits AS (
       SELECT domain, score, created_at,
              ROW_NUMBER() OVER (PARTITION BY domain ORDER BY created_at DESC) AS rn
       FROM audits
       WHERE user_id IN (SELECT id FROM users WHERE id = $1 OR team_id = (SELECT team_id FROM users WHERE id = $1))
         AND score IS NOT NULL
         AND domain IN (SELECT domain FROM visible_domains)
     )
     SELECT vd.domain,
            latest.score AS latest_score, latest.created_at AS latest_audit_at,
            previous.score AS previous_score
     FROM visible_domains vd
     LEFT JOIN ranked_audits latest ON latest.domain = vd.domain AND latest.rn = 1
     LEFT JOIN ranked_audits previous ON previous.domain = vd.domain AND previous.rn = 2
     ORDER BY vd.domain ASC`,
    [req.user.id]
  );

  const portfolio = result.rows.map((row) => {
    const latestScore = row.latest_score;
    const previousScore = row.previous_score;
    const trend = latestScore != null && previousScore != null ? latestScore - previousScore : null;
    const alerts = [];
    if (trend != null && previousScore - latestScore >= SCORE_DROP_ALERT_THRESHOLD) {
      alerts.push({ type: 'score_drop', delta: trend });
    }
    return {
      domain: row.domain,
      latestScore,
      latestAuditAt: row.latest_audit_at,
      previousScore,
      trend,
      alerts,
    };
  });

  res.json(portfolio);
});

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
