require('dotenv').config();
const pool = require('../db/pool');
// Required as namespaced objects (not destructured) so tests can mock
// individual methods with node:test's t.mock.method — that only works when
// the call site does a live property lookup (services.foo()) rather than
// holding a destructured reference captured at require time.
const contentAnalysis = require('./contentAnalysis');
const dataforseo = require('./dataforseo');
const claude = require('./claude');
const email = require('./email');
const googleSearchConsole = require('./googleSearchConsole');

const SCORE_DROP_ALERT_THRESHOLD = 10;

async function processAuditJob(job) {
  const { auditId, domain, categories = ['technical', 'content'], language = 'en', notifyEmail = false } = job.data;

  const auditRow = await pool.query('SELECT user_id FROM audits WHERE id = $1', [auditId]);
  const userId = auditRow.rows[0]?.user_id;

  const previousResult = await pool.query(
    `SELECT score FROM audits WHERE user_id = $1 AND domain = $2 AND id != $3 AND score IS NOT NULL
     ORDER BY created_at DESC LIMIT 1`,
    [userId, domain, auditId]
  );
  const previousScore = previousResult.rows[0]?.score ?? null;

  const gscLinkResult = await pool.query(
    `SELECT md.gsc_site_url, u.gsc_refresh_token
     FROM monitored_domains md JOIN users u ON u.id = md.user_id
     WHERE md.user_id = $1 AND md.domain = $2`,
    [userId, domain]
  );
  const gscLink = gscLinkResult.rows[0];

  const tasks = {
    technical: categories.includes('technical')
      ? dataforseo.getOnPageAudit(domain).catch(() => null)
      : Promise.resolve(null),
    content: categories.includes('content')
      ? contentAnalysis.analyzeContent(domain).catch(() => null)
      : Promise.resolve(null),
    backlinks: categories.includes('backlinks')
      ? dataforseo.getBacklinkSummary(domain).catch(() => null)
      : Promise.resolve(null),
    gsc:
      gscLink?.gsc_site_url && gscLink?.gsc_refresh_token
        ? googleSearchConsole
            .refreshAccessToken(gscLink.gsc_refresh_token)
            .then((accessToken) => googleSearchConsole.querySearchAnalytics(accessToken, gscLink.gsc_site_url))
            .catch((err) => {
              console.error('GSC fetch failed for audit', auditId, ':', err.response?.data || err.message);
              return null;
            })
        : Promise.resolve(null),
  };

  const [technical, content, backlinks, gscResult] = await Promise.all([
    tasks.technical,
    tasks.content,
    tasks.backlinks,
    tasks.gsc,
  ]);

  const keywords =
    categories.includes('keywords') && content?.title
      ? await dataforseo.getKeywordIdeas(content.title).catch(() => null)
      : null;

  const aiRecommendations = await claude
    .generateRecommendations({ domain, technical, content, keywords, backlinks, language })
    .catch(() => []);

  const penalty = aiRecommendations.reduce((sum, fix) => {
    if (fix.severity === 'high') return sum + 15;
    if (fix.severity === 'medium') return sum + 7;
    if (fix.severity === 'low') return sum + 3;
    return sum;
  }, 0);
  const score = Math.max(0, Math.min(100, 100 - penalty));

  await pool.query(
    `UPDATE audits SET status = 'completed', technical_result = $1, content_result = $2,
     keyword_result = $3, backlink_result = $4, ai_recommendations = $5, score = $6, gsc_result = $7, completed_at = now()
     WHERE id = $8`,
    [technical, content, JSON.stringify(keywords), backlinks, JSON.stringify(aiRecommendations), score, JSON.stringify(gscResult), auditId]
  );

  if (userId && (notifyEmail || (previousScore != null && previousScore - score >= SCORE_DROP_ALERT_THRESHOLD))) {
    const userResult = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
    const userEmail = userResult.rows[0]?.email;
    const reportUrl = `${process.env.FRONTEND_URL}/audits/${auditId}`;

    if (userEmail) {
      try {
        if (previousScore != null && previousScore - score >= SCORE_DROP_ALERT_THRESHOLD) {
          await email.sendScoreDropAlertEmail(userEmail, { domain, previousScore, score, reportUrl });
        } else if (notifyEmail) {
          await email.sendAuditReadyEmail(userEmail, { domain, score, reportUrl });
        }
      } catch (err) {
        console.error('Failed to send audit notification email:', err.message);
      }
    }
  }

  return { score, previousScore, gscResult };
}

module.exports = { processAuditJob, SCORE_DROP_ALERT_THRESHOLD };
