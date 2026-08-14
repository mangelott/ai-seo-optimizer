const express = require('express');
const cors = require('cors');

const auditRoutes = require('./routes/audit');
const authRoutes = require('./routes/auth');
const quickScanRoutes = require('./routes/quickScan');
const billingRoutes = require('./routes/billing');
const stripeWebhookRoutes = require('./routes/stripeWebhook');

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

module.exports = app;
