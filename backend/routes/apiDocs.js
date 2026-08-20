const express = require('express');

const router = express.Router();

// Minimal, hand-written reference for the Agency API surface (see
// middleware/apiKeyAuth.js / routes/apiKeys.js) — not an OpenAPI spec, kept
// as plain JSON so it stays trivial to keep in sync as endpoints are added.
router.get('/', (req, res) => {
  res.json({
    version: '1.0',
    authentication: {
      type: 'bearer',
      header: 'Authorization: Bearer <api_key>',
      note: 'API keys require the Agency plan. Generate one via POST /api/keys while logged in to the web app (JWT session required for key management).',
    },
    rateLimit: '100 requests / 15 minutes per API key',
    endpoints: [
      {
        method: 'POST',
        path: '/api/audit',
        description: 'Start a full SEO audit for a domain.',
        body: { domain: 'string (required)', language: 'string (optional, defaults to "en")' },
        response: { auditId: 'number', status: '"pending"' },
      },
      {
        method: 'GET',
        path: '/api/audit/:id',
        description: 'Fetch the current status and results of an audit.',
      },
      {
        method: 'GET',
        path: '/api/domains',
        description: 'List monitored domains for the authenticated account.',
      },
    ],
  });
});

module.exports = router;
