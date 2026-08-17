const express = require('express');
const { requireAuth } = require('./keycloak-auth');
const { computeTodayReport, computeReportsForDateRange } = require('./sprout');

const app = express();
const PORT = process.env.PORT || 3000;

// Health check — NOT protected by Keycloak, so container orchestrators
// (Docker, Kubernetes, etc.) can verify the app is alive without needing a token.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

// The actual report endpoint — protected by Keycloak.
app.get('/api/shift-board', requireAuth, async (req, res) => {
  const requestedDays = parseInt(req.query.days, 10);

  try {
    if (requestedDays && requestedDays > 1) {
      const dayResults = await computeReportsForDateRange(requestedDays);
      return res.json({ ok: true, reports: dayResults, generatedAt: new Date().toISOString() });
    }

    const report = await computeTodayReport();
    return res.json({ ok: true, report, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('Report generation failed:', err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Shift Board backend listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Report endpoint (requires Keycloak Bearer token): http://localhost:${PORT}/api/shift-board`);
});
