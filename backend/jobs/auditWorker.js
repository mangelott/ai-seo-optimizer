require('dotenv').config();
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const pool = require('../db/pool');
const { analyzeContent } = require('../services/contentAnalysis');
const { getOnPageAudit, getKeywordIdeas, getBacklinkSummary } = require('../services/dataforseo');
const { generateRecommendations } = require('../services/claude');
const { sendAuditReadyEmail, sendScoreDropAlertEmail } = require('../services/email');
const { refreshAccessToken, querySearchAnalytics } = require('../services/googleSearchConsole');

const SCORE_DROP_ALERT_THRESHOLD = 10;

const worker = new Worker(
  'audit',
  async (job) => {
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
      technical: categories.includes('technical') ? getOnPageAudit(domain).catch(() => null) : Promise.resolve(null),
      content: categories.includes('content') ? analyzeContent(domain).catch(() => null) : Promise.resolve(null),
      backlinks: categories.includes('backlinks') ? getBacklinkSummary(domain).catch(() => null) : Promise.resolve(null),
      gsc:
        gscLink?.gsc_site_url && gscLink?.gsc_refresh_token
          ? refreshAccessToken(gscLink.gsc_refresh_token)
              .then((accessToken) => querySearchAnalytics(accessToken, gscLink.gsc_site_url))
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
        ? await getKeywordIdeas(content.title).catch(() => null)
        : null;

    const aiRecommendations = await generateRecommendations({
      domain,
      technical,
      content,
      keywords,
      backlinks,
      language,
    }).catch(() => []);

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
      const email = userResult.rows[0]?.email;
      const reportUrl = `${process.env.FRONTEND_URL}/audits/${auditId}`;

      if (email) {
        try {
          if (previousScore != null && previousScore - score >= SCORE_DROP_ALERT_THRESHOLD) {
            await sendScoreDropAlertEmail(email, { domain, previousScore, score, reportUrl });
          } else if (notifyEmail) {
            await sendAuditReadyEmail(email, { domain, score, reportUrl });
          }
        } catch (err) {
          console.error('Failed to send audit notification email:', err.message);
        }
      }
    }
  },
  { connection }
);

worker.on('failed', (job, err) => {
  console.error(`Audit job ${job.id} failed:`, err.message);
});

module.exports = worker;
