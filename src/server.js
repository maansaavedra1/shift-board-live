const path = require('path');
const express = require('express');
const { requireAuth } = require('./keycloak-auth');
const { computeTodayReport, computeReportsForDateRange } = require('./sprout');
const { onboardUser, listUsers, isConfigured: adminApiConfigured, KeycloakAdminError } = require('./keycloak-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

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

// --- Admin user management, callable from the dashboard's "Add User" panel ---
// Protected the same way as /api/shift-board: requireAuth already checks
// for the admin role (see keycloak-auth.js / REQUIRED_ROLE), so only
// people who can already see the dashboard can reach these. This calls
// Keycloak's Admin API as the "shift-board-admin-api" service account —
// the logged-in person's own token is never used for that part, it's
// only used to prove they're allowed to trigger this action at all.

app.get('/api/admin/users', requireAuth, async (req, res) => {
  if (!adminApiConfigured()) {
    return res.status(501).json({ ok: false, error: 'Keycloak Admin API is not configured on this server (KEYCLOAK_ADMIN_CLIENT_SECRET missing). User management is unavailable until that\'s set.' });
  }
  try {
    const users = await listUsers();
    return res.json({ ok: true, users });
  } catch (err) {
    const message = err instanceof KeycloakAdminError ? err.message : 'Failed to list users.';
    console.error('Listing Keycloak users failed:', err.message);
    return res.status(502).json({ ok: false, error: message });
  }
});

app.post('/api/admin/users', requireAuth, async (req, res) => {
  if (!adminApiConfigured()) {
    return res.status(501).json({ ok: false, error: 'Keycloak Admin API is not configured on this server (KEYCLOAK_ADMIN_CLIENT_SECRET missing). User management is unavailable until that\'s set.' });
  }

  const { username, email, firstName, lastName } = req.body || {};
  if (!username || !email || !firstName || !lastName) {
    return res.status(400).json({ ok: false, error: 'username, email, firstName, and lastName are all required.' });
  }

  try {
    const result = await onboardUser({ username, email, firstName, lastName });
    // Logged so whoever has server/log access can audit who added whom —
    // the temporary password itself is deliberately NOT logged here.
    console.log(`Admin user "${req.user && req.user.preferred_username}" onboarded new user "${username}" with role "${result.role}".`);
    return res.json({ ok: true, username: result.username, temporaryPassword: result.password, role: result.role });
  } catch (err) {
    const message = err instanceof KeycloakAdminError ? err.message : 'Failed to create user.';
    console.error('Onboarding user via API failed:', err.message);
    return res.status(502).json({ ok: false, error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Shift Board backend listening on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Report endpoint (requires Keycloak Bearer token): http://localhost:${PORT}/api/shift-board`);
});
