require('dotenv').config();
const app = require('./app');

// Render's free tier doesn't offer a separate Background Worker service, so
// the audit worker runs in-process here rather than as its own deployment.
// Fine at this scale: Express and BullMQ are both async/event-loop based.
require('./jobs/auditWorker');

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
