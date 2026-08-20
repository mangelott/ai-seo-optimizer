const express = require('express');
const multer = require('multer');
const pool = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { getEffectivePlanKey } = require('../middleware/planLimit');
const { PLANS } = require('../config/plans');
const { parseLogContent, compareWithCrawledPages } = require('../services/logAnalysis');

const router = express.Router();

// Real multipart/form-data file upload, not a JSON/text field — matches how
// a browser <input type="file"> submits without the caller having to read
// the file into a JS string first. memoryStorage is fine at this size;
// switch to disk storage only if uploads start running past tens of MB.
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// multer's own errors (e.g. LIMIT_FILE_SIZE) reject the request before
// Express's default error handler would run, which would otherwise return a
// bare 500 — surface them as a normal 400 like every other validation error
// in this route instead.
function uploadLogFile(req, res, next) {
  upload.single('logFile')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// TODO(frontend): there's no UI for this yet. When it's built, POST here as
// multipart/form-data with fields `domain` (text) and `logFile` (the access
// log file straight from an <input type="file">) — e.g. with FormData:
//   const body = new FormData();
//   body.append('domain', domain);
//   body.append('logFile', fileInput.files[0]);
//   fetch('/api/log-analysis/upload', { method: 'POST', headers: { Authorization: ... }, body });
// Do not set a Content-Type header manually — the browser/fetch sets the
// multipart boundary itself. See test/logAnalysisRoute.test.js for a working
// request example (built with the same FormData/Blob APIs).
router.post('/upload', requireAuth, uploadLogFile, async (req, res) => {
  const { domain } = req.body;
  if (!domain) return res.status(400).json({ error: 'domain is required' });
  if (!req.file) return res.status(400).json({ error: 'logFile is required' });

  const effectivePlanKey = await getEffectivePlanKey(req.user.id);
  if (!PLANS[effectivePlanKey]?.serverLogAnalysis) {
    return res.status(402).json({ error: 'Server log analysis requires the Agency plan' });
  }

  const logContent = req.file.buffer.toString('utf8');
  if (!logContent.trim()) {
    return res.status(400).json({ error: 'logFile is empty' });
  }

  const { linesParsed, linesSkipped, botHitsSummary } = parseLogContent(logContent);

  // Snapshots the latest completed audit at upload time — see the comment on
  // server_log_uploads in db/schema.sql for why this isn't recomputed later.
  const auditResult = await pool.query(
    `SELECT id FROM audits WHERE user_id = $1 AND domain = $2 AND status = 'completed'
     ORDER BY created_at DESC LIMIT 1`,
    [req.user.id, domain]
  );
  const auditId = auditResult.rows[0]?.id ?? null;

  let comparisonResult = null;
  if (auditId) {
    const pagesResult = await pool.query('SELECT url FROM crawled_pages WHERE audit_id = $1', [auditId]);
    comparisonResult = compareWithCrawledPages(botHitsSummary, pagesResult.rows);
  }

  const insertResult = await pool.query(
    `INSERT INTO server_log_uploads (user_id, domain, audit_id, bot_hits, comparison_result, lines_parsed, lines_skipped)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, domain, audit_id, bot_hits, comparison_result, lines_parsed, lines_skipped, created_at`,
    [req.user.id, domain, auditId, JSON.stringify(botHitsSummary), comparisonResult ? JSON.stringify(comparisonResult) : null, linesParsed, linesSkipped]
  );

  res.status(201).json(insertResult.rows[0]);
});

router.get('/', requireAuth, async (req, res) => {
  const { domain } = req.query;
  const params = [req.user.id];
  let query = `SELECT id, domain, audit_id, bot_hits, comparison_result, lines_parsed, lines_skipped, created_at
               FROM server_log_uploads WHERE user_id = $1`;
  if (domain) {
    params.push(domain);
    query += ` AND domain = $${params.length}`;
  }
  query += ' ORDER BY created_at DESC';

  const result = await pool.query(query, params);
  res.json(result.rows);
});

module.exports = router;
