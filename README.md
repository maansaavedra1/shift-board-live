# Shift Board — Docker + Keycloak Reference Implementation

This is a containerized version of the Shift Board backend, secured with Keycloak instead of the shared-key approach used in the Apps Script and Azure Functions versions. The actual Sprout HR integration logic (`src/sprout.js`) is identical to the verified Azure Functions port — same classification rules, same confirmed API quirks.

## What's actually been verified vs. what hasn't

**Verified (tested directly, real results shown below):**
- ✅ The server boots correctly and responds to requests
- ✅ The `/health` endpoint works and is intentionally left unprotected (so container orchestration tools can check if it's alive without needing a token)
- ✅ Requests with no token are correctly rejected
- ✅ Requests with an invalid/malformed token are correctly rejected
- ✅ The app fails **closed** (denies access) if Keycloak isn't configured at all, rather than accidentally allowing requests through

**Now built, but still unverified against a real Keycloak/Azure deployment:**
- 🟡 **The dashboard now has Keycloak login wired in** (`public/index.html`, using the `keycloak-js` adapter) — it redirects to Keycloak on load, attaches the access token to every `/api/shift-board` request, and silently refreshes the token before it expires. This was written and reasoned through carefully, but has not been run against a live Keycloak instance in this session.
- 🟡 The server now serves the dashboard itself (`express.static`) as well as the API, so one container/deployment covers both — also not yet run end-to-end.
- 🟡 **Keycloak connection details (`KEYCLOAK_URL`/`KEYCLOAK_REALM`/`KEYCLOAK_CLIENT_ID`) are no longer hardcoded in `index.html`.** The frontend fetches them from a new `/config.json` endpoint on the backend, which reads them from environment variables. This means the same built image can move between environments (local Docker, staging, Azure) with just an env var change — no code edit or rebuild.
- 🟡 See `AZURE_DEPLOYMENT.md` for the concrete deployment path and a checklist of what to test once it's actually running on Azure.

**Not yet built at all — flagged, not solved:**
**Now built: role-based access control (admin-only for now).**
- ✅ There is now a real `admin` realm role in `keycloak/shift-board-realm.json`. Being logged into Keycloak is no longer enough on its own — `keycloak-auth.js` checks the token for this role and returns 403 if it's missing, even for a valid, successfully-logged-in user.
- ✅ Two test accounts are included: `testuser` / `testpassword` (has the `admin` role — should see the dashboard) and `testuser-noaccess` / `testpassword` (logged in, no role — should get a clear "you don't have access yet" message). Use the second one to confirm the restriction actually works, not just the happy path.
- ✅ **To onboard someone for real:** in Keycloak's admin console, create their user account, *then* go to that user → **Role mapping → Assign role → `admin`**. Creating the account alone does not grant access — this second step is what does.
- ✅ The role name is configurable via the `REQUIRED_ROLE` environment variable (defaults to `admin`) — set it to an empty string to temporarily disable the role check (any logged-in user allowed) while testing, but this is not recommended once real users are onboarded.
- ⚠️ Still not built: any distinction *within* the dashboard (e.g., some users seeing more than others). Today it's binary — either you have the `admin` role and see everything, or you don't and see nothing. Extend `keycloak-auth.js`'s `hasRequiredRole()` check if that's ever needed.

**User onboarding is manual, through Keycloak's own admin console** (Users → Add User → set credentials → assign the `admin` role), or via the `users` array in `keycloak/shift-board-realm.json` (only takes effect on a *fresh* realm import, not on an existing realm). There is no self-registration or bulk-invite flow built here.

**Still not yet verified — needs real testing before production use:**
- ❌ A request with a genuinely valid Keycloak token has never been tested (no real Keycloak instance was available to generate one in this session)
- ❌ The actual Docker build/run has not been executed (no Docker daemon available in the environment this was built in) — only the underlying Node.js code was run and tested directly
- ❌ Token refresh behavior (`getFreshToken()` in `index.html`) has not been observed against a real token's actual expiry — the logic is standard `keycloak-js` usage, but "should work" isn't the same as "watched it work"

## Quick Start (local testing)

1. Copy `.env.example` to `.env` and fill in your real Sprout sandbox credentials
2. Run `docker compose up --build`
3. This starts two things: the Shift Board backend, and a local Keycloak instance (for testing only — not production-grade as configured)
4. Visit `http://localhost:8080` to access Keycloak's admin console (login: `admin` / `admin`) and set up a realm called `shift-board`, plus a client and a test user
5. Once you have a real token from that local Keycloak, test the protected endpoint:
   ```
   curl -H "Authorization: Bearer YOUR_TOKEN" http://localhost:3000/api/shift-board
   ```

## Moving to a Real Deployment

See `AZURE_DEPLOYMENT.md` for a concrete, step-by-step path (Azure
Container Apps + a production Keycloak backed by Postgres). Short version:

1. Point `KEYCLOAK_URL` and `KEYCLOAK_REALM` at whichever Keycloak instance you'll actually use in production — either one the client already runs, or one you stand up and manage
2. Update `KEYCLOAK_CONFIG.url` in `public/index.html` to match, then rebuild
3. Build and push the Docker image to wherever it'll run
4. Lock down `keycloak/shift-board-realm.json`'s `redirectUris`/`webOrigins` (shipped as `*` for local testing only) to your real dashboard URL before going live

## File Structure

```
shift-board-docker/
├── Dockerfile
├── docker-compose.yml       (includes a local Keycloak for testing)
├── .env.example
├── AZURE_DEPLOYMENT.md      (step-by-step Azure Container Apps deployment)
├── package.json
├── keycloak/
│   └── shift-board-realm.json  (Keycloak realm/client/test-user import file)
├── public/
│   └── index.html           (dashboard — now with Keycloak login wired in)
└── src/
    ├── server.js            (Express app, routes, serves the dashboard + API)
    ├── keycloak-auth.js     (JWT verification middleware)
    └── sprout.js            (Sprout HR integration — same logic as the Azure port)
```
