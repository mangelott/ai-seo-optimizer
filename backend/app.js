const express = require('express');
const cors = require('cors');

const auditRoutes = require('./routes/audit');
const authRoutes = require('./routes/auth');
const quickScanRoutes = require('./routes/quickScan');
const billingRoutes = require('./routes/billing');
const stripeWebhookRoutes = require('./routes/stripeWebhook');
const domainsRoutes = require('./routes/domains');
const publicReportRoutes = require('./routes/publicReport');
const gscRoutes = require('./routes/gsc');
const ga4Routes = require('./routes/ga4');
const wordpressRoutes = require('./routes/wordpress');
const teamsRoutes = require('./routes/teams');
const githubRoutes = require('./routes/github');
const aeoRoutes = require('./routes/aeo');
const trackedKeywordsRoutes = require('./routes/trackedKeywords');

const app = express();

app.use(cors());

// Must be mounted before express.json() — Stripe needs the raw body to verify signatures.
app.use('/api/billing/webhook', stripeWebhookRoutes);

app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/api/auth', authRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/quick-scan', quickScanRoutes);
app.use('/api/billing', billingRoutes);
app.use('/api/domains', domainsRoutes);
app.use('/api/public/report', publicReportRoutes);
app.use('/api/gsc', gscRoutes);
app.use('/api/ga4', ga4Routes);
app.use('/api/wordpress', wordpressRoutes);
app.use('/api/teams', teamsRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/aeo', aeoRoutes);
app.use('/api/rank-tracking', trackedKeywordsRoutes);

module.exports = app;
