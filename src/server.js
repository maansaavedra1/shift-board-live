const path = require('path');
const express = require('express');
const { requireAuth } = require('./keycloak-auth');
const { computeTodayReport, computeReportsForDateRange } = require('./sprout');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve the dashboard (index.html) as static files from the same container,
// so one image/deployment covers both the UI and the API. Not required —
// you can host index.html separately (e.g. a static site / CDN) and point
// it at this backend's URL instead — but this keeps a single-container
// deployment possible on Azure Container Apps, App Service, etc.
app.use(express.static(path.join(__dirname, '..', 'public')));

// Health check — NOT protected by Keycloak, so container orchestrators
// (Docker, Kubernetes, etc.) can verify the app is alive without needing a token.
app.get('/health', (req, res) => {
  res.json({ ok: true, status: 'healthy' });
});

// Serves the frontend's Keycloak connection details from environment
// variables, instead of having them hardcoded in index.html. This is what
// lets the same built container/image move between environments (local
// Docker, staging, production Azure) just by changing env vars — no code
// edit or rebuild needed each time the Keycloak URL changes.
//
// Safe to expose publicly: none of these are secrets. This is a *public*
// Keycloak client (no client secret), so the URL/realm/client ID are
// meant to be visible to the browser — Keycloak's own login flow requires
// the browser to know them.
app.get('/config.json', (req, res) => {
  res.json({
    keycloakUrl: process.env.KEYCLOAK_URL || '',
    keycloakRealm: process.env.KEYCLOAK_REALM || '',
    keycloakClientId: process.env.KEYCLOAK_CLIENT_ID || 'shift-board-app'
  });
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
