const pool = require('../db/pool');
const { analyzeContent } = require('./contentAnalysis');
const { scoreContent } = require('./scoring');

async function runQuickScan(domain, ipAddress) {
  const content = await analyzeContent(domain);
  const { score, issues } = scoreContent(content);

  const result = await pool.query(
    `INSERT INTO quick_scans (domain, ip_address, score, issues_count, full_result)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [domain, ipAddress, score, issues.length, { content, issues }]
  );

  return { scanId: result.rows[0].id, score, issuesCount: issues.length };
}

module.exports = { runQuickScan };
