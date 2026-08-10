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
    const { auditId, domain, categories = ['technical', 'content'], language = 'en' } = job.data;

    const tasks = {
      technical: categories.includes('technical') ? getOnPageAudit(domain).catch(() => null) : Promise.resolve(null),
      content: categories.includes('content') ? analyzeContent(domain).catch(() => null) : Promise.resolve(null),
      backlinks: categories.includes('backlinks') ? getBacklinkSummary(domain).catch(() => null) : Promise.resolve(null),
    };

    const [technical, content, backlinks] = await Promise.all([
      tasks.technical,
      tasks.content,
      tasks.backlinks,
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
       keyword_result = $3, backlink_result = $4, ai_recommendations = $5, score = $6, completed_at = now()
       WHERE id = $7`,
      [technical, content, JSON.stringify(keywords), backlinks, JSON.stringify(aiRecommendations), score, auditId]
    );
  },
  { connection }
);

worker.on('failed', (job, err) => {
  console.error(`Audit job ${job.id} failed:`, err.message);
});

module.exports = worker;
