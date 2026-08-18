const express = require('express');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { enforcePlanLimit } = require('../middleware/planLimit');
const { createAudit } = require('../services/auditRunner');
const { decryptSecret } = require('../services/encryption');
const { resolvePostId, applyField } = require('../services/wordpress');
const github = require('../services/github');

const router = express.Router();

router.post('/', requireAuth, enforcePlanLimit, async (req, res) => {
  const { domain, language } = req.body;
  if (!domain) return res.status(400).json({ error: 'Domain is required' });

  const auditId = await createAudit({
    userId: req.user.id,
    domain,
    language,
    planKey: req.planKey,
    categories: req.plan.categories,
  });

  res.status(202).json({ auditId, status: 'pending' });
});

// Team members see each other's audits (shared agency workspace); solo
// users only ever match themselves, since NULL never equals NULL in SQL.
router.get('/:id', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT * FROM audits WHERE id = $1
     AND user_id IN (SELECT id FROM users WHERE id = $2 OR team_id = (SELECT team_id FROM users WHERE id = $2))`,
    [req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json(result.rows[0]);
});

router.get('/', requireAuth, async (req, res) => {
  const result = await pool.query(
    `SELECT id, domain, status, score, created_at, completed_at,
     jsonb_array_length(COALESCE(ai_recommendations, '[]'::jsonb)) AS issue_count
     FROM audits
     WHERE user_id IN (SELECT id FROM users WHERE id = $1 OR team_id = (SELECT team_id FROM users WHERE id = $1))
     ORDER BY created_at DESC`,
    [req.user.id]
  );
  res.json(result.rows);
});

router.patch('/:id/share', requireAuth, async (req, res) => {
  const { shared } = req.body;
  const result = await pool.query(
    'UPDATE audits SET is_shared = $1 WHERE id = $2 AND user_id = $3 RETURNING is_shared, share_token',
    [!!shared, req.params.id, req.user.id]
  );
  if (!result.rows[0]) return res.status(404).json({ error: 'Audit not found' });
  res.json(result.rows[0]);
});

async function applyViaWordPress(domainRow, audit, fix) {
  if (!fix.wpField) {
    return { status: 400, body: { error: 'This fix cannot be auto-applied via WordPress' } };
  }
  if (!domainRow.wp_url || !domainRow.wp_app_password_encrypted) {
    return { status: 400, body: { error: 'Connect a WordPress site to this domain first' } };
  }

  try {
    const appPassword = await decryptSecret(domainRow.wp_app_password_encrypted);
    const postId = await resolvePostId(domainRow.wp_url, domainRow.wp_username, appPassword, audit.domain);
    await applyField(domainRow.wp_url, domainRow.wp_username, appPassword, {
      postId,
      field: fix.wpField,
      value: fix.wpValue,
      target: fix.wpTarget,
    });
  } catch (err) {
    console.error('WordPress auto-fix failed:', err.response?.data || err.message);
    return {
      status: 502,
      body: { error: 'Could not apply this fix on WordPress. Check the connection and try again.' },
    };
  }

  return { status: 200, body: { fix: { ...fix, applied: true, appliedAt: new Date().toISOString() } } };
}

async function applyViaGithub(domainRow, audit, fix, auditId, index, manualFilePath, req) {
  if (!fix.sourceSearchText || !fix.sourceReplaceText) {
    return { status: 400, body: { error: 'This fix cannot be auto-applied via GitHub' } };
  }
  if (!domainRow.github_repo) {
    return { status: 400, body: { error: 'Connect a GitHub repository to this domain first' } };
  }

  const userResult = await pool.query('SELECT github_installation_id FROM users WHERE id = $1', [req.user.id]);
  const installationId = userResult.rows[0]?.github_installation_id;
  if (!installationId) {
    return { status: 400, body: { error: 'Connect GitHub first' } };
  }

  const branch = domainRow.github_branch || 'main';
  const repo = domainRow.github_repo;

  let filePath = manualFilePath;
  if (!filePath) {
    let candidates;
    try {
      candidates = await github.searchCode(installationId, repo, fix.sourceSearchText);
    } catch (err) {
      console.error('GitHub code search failed:', err.response?.data || err.message);
      return { status: 502, body: { error: 'Could not search the repository. Check the GitHub connection.' } };
    }
    if (candidates.length !== 1) {
      return {
        status: 409,
        body: {
          error:
            candidates.length === 0
              ? "Couldn't find this text in the repository. Specify the file manually."
              : 'Found this text in multiple files. Pick the right one.',
          candidates,
        },
      };
    }
    filePath = candidates[0];
  }

  let file;
  try {
    file = await github.getFile(installationId, repo, filePath, branch);
  } catch (err) {
    console.error('GitHub file fetch failed:', err.response?.data || err.message);
    return { status: 502, body: { error: 'Could not read that file from the repository.' } };
  }

  const occurrences = file.content.split(fix.sourceSearchText).length - 1;
  if (occurrences !== 1) {
    return {
      status: 409,
      body: {
        error:
          occurrences === 0
            ? 'That text was not found in this file. Specify the correct file manually.'
            : 'That text appears more than once in this file — not safe to auto-apply. Specify the exact file, or apply this fix manually.',
        candidates: [],
      },
    };
  }

  const newContent = file.content.replace(fix.sourceSearchText, fix.sourceReplaceText);
  const branchName = `ai-seo-optimizer/audit-${auditId}-fix-${index}-${Date.now()}`;

  try {
    const baseSha = await github.getBranchSha(installationId, repo, branch);
    await github.createBranch(installationId, repo, branchName, baseSha);
    await github.updateFile(installationId, repo, filePath, {
      content: newContent,
      sha: file.sha,
      branch: branchName,
      message: `AI SEO Optimizer: ${fix.title}`,
    });
    const pr = await github.createPullRequest(installationId, repo, {
      title: `AI SEO Optimizer: ${fix.title}`,
      head: branchName,
      base: branch,
      body: `${fix.what || ''}\n\n${fix.why || ''}\n\nGenerated from the SEO audit for ${audit.domain}.\n\n${process.env.FRONTEND_URL}/audits/${auditId}`,
    });
    return {
      status: 200,
      body: {
        fix: {
          ...fix,
          prUrl: pr.url,
          prNumber: pr.number,
          appliedVia: 'github',
          appliedAt: new Date().toISOString(),
        },
      },
    };
  } catch (err) {
    console.error('GitHub auto-fix failed:', err.response?.data || err.message);
    return { status: 502, body: { error: 'Could not open a pull request. Check the GitHub connection and try again.' } };
  }
}

router.post('/:id/fixes/:index/apply', requireAuth, async (req, res) => {
  const auditResult = await pool.query('SELECT * FROM audits WHERE id = $1 AND user_id = $2', [
    req.params.id,
    req.user.id,
  ]);
  const audit = auditResult.rows[0];
  if (!audit) return res.status(404).json({ error: 'Audit not found' });

  const fixes = Array.isArray(audit.ai_recommendations) ? audit.ai_recommendations : [];
  const index = parseInt(req.params.index, 10);
  const fix = fixes[index];
  if (!fix) return res.status(404).json({ error: 'Fix not found' });

  const domainResult = await pool.query('SELECT * FROM monitored_domains WHERE user_id = $1 AND domain = $2', [
    req.user.id,
    audit.domain,
  ]);
  const domainRow = domainResult.rows[0];
  if (!domainRow?.auto_fix_enabled) {
    return res.status(400).json({ error: 'Auto-fix is not enabled for this domain' });
  }

  let result;
  if (domainRow.wp_url) {
    result = await applyViaWordPress(domainRow, audit, fix);
  } else if (domainRow.github_repo) {
    result = await applyViaGithub(domainRow, audit, fix, audit.id, index, req.body?.filePath, req);
  } else {
    return res.status(400).json({ error: 'Connect WordPress or GitHub to this domain first' });
  }

  if (result.status !== 200) {
    return res.status(result.status).json(result.body);
  }

  fixes[index] = result.body.fix;
  await pool.query('UPDATE audits SET ai_recommendations = $1 WHERE id = $2', [JSON.stringify(fixes), audit.id]);
  res.json({ ok: true, fix: fixes[index] });
});

module.exports = router;
