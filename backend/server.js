require('dotenv').config();
const cron = require('node-cron');
const app = require('./app');
const { runDueRecurringAudits } = require('./jobs/recurringAudits');
const { runDueAeoChecks } = require('./jobs/aeoTracking');
const { runDueRankChecks } = require('./jobs/rankTracking');

// Render's free tier doesn't offer a separate Background Worker service, so
// the audit worker runs in-process here rather than as its own deployment.
// Fine at this scale: Express and BullMQ are both async/event-loop based.
require('./jobs/auditWorker');

// Checks hourly for monitored domains whose recurring audit is due. Hourly
// (not daily) keeps day-granularity schedules from drifting by a full day
// if the process restarts around the scheduled time.
cron.schedule('0 * * * *', () => {
  runDueRecurringAudits().catch((err) => console.error('Recurring audits run failed:', err));
});

// Daily (not hourly, unlike the recurring-audits check above) since AEO
// checks are due weekly at minimum (jobs/aeoTracking.js) — a daily tick is
// frequent enough to keep drift to under a day without adding cost.
cron.schedule('30 2 * * *', () => {
  runDueAeoChecks().catch((err) => console.error('AEO tracking run failed:', err));
});

// Hourly, like the recurring-audits check above (not daily like the AEO check):
// rank checks are due daily at minimum (jobs/rankTracking.js), so an hourly
// tick keeps drift to under a day, same reasoning as runDueRecurringAudits.
cron.schedule('15 * * * *', () => {
  runDueRankChecks().catch((err) => console.error('Rank tracking run failed:', err));
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
