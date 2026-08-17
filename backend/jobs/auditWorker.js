require('dotenv').config();
const { Worker } = require('bullmq');
const { connection } = require('./queue');
const { processAuditJob } = require('../services/auditProcessor');

const worker = new Worker('audit', processAuditJob, { connection });

worker.on('failed', (job, err) => {
  console.error(`Audit job ${job.id} failed:`, err.message);
});

module.exports = worker;
