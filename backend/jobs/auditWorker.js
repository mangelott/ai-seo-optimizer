require('dotenv').config();
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const pool = require('../db/pool');
const { analyzeContent } = require('../services/contentAnalysis');
const { getOnPageAudit, getKeywordIdeas, getBacklinkSummary } = require('../services/dataforseo');
const { generateRecommendations } = require('../services/claude');

const worker = new Worker(
  'audit',
  async (job) => {
    const { auditId, domain } = job.data;

    const [technical, content, backlinks] = await Promise.all([
      getOnPageAudit(domain).catch(() => null),
      analyzeContent(domain).catch(() => null),
      getBacklinkSummary(domain).catch(() => null),
    ]);

    const keywords = content?.title
      ? await getKeywordIdeas(content.title).catch(() => null)
      : null;

    const aiRecommendations = await generateRecommendations({
      domain,
      technical,
      content,
      keywords,
      backlinks,
    }).catch(() => null);

    await pool.query(
      `UPDATE audits SET status = 'completed', technical_result = $1, content_result = $2,
       keyword_result = $3, backlink_result = $4, ai_recommendations = $5, completed_at = now()
       WHERE id = $6`,
      [technical, content, keywords, backlinks, aiRecommendations, auditId]
    );
  },
  { connection }
);

worker.on('failed', (job, err) => {
  console.error(`Audit job ${job.id} failed:`, err.message);
});

module.exports = worker;
