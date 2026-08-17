# Shift Board — Docker + Keycloak Reference Implementation

This is a containerized version of the Shift Board backend, secured with Keycloak instead of the shared-key approach used in the Apps Script and Azure Functions versions. The actual Sprout HR integration logic (`src/sprout.js`) is identical to the verified Azure Functions port — same classification rules, same confirmed API quirks.

## What's actually been verified vs. what hasn't

**Verified (tested directly, real results shown below):**
- ✅ The server boots correctly and responds to requests
- ✅ The `/health` endpoint works and is intentionally left unprotected (so container orchestration tools can check if it's alive without needing a token)
- ✅ Requests with no token are correctly rejected
- ✅ Requests with an invalid/malformed token are correctly rejected
- ✅ The app fails **closed** (denies access) if Keycloak isn't configured at all, rather than accidentally allowing requests through

**NOT yet verified — needs real testing before production use:**
- ❌ A request with a genuinely valid Keycloak token has never been tested (no real Keycloak instance was available to generate one)
- ❌ The actual Docker build/run has not been executed (no Docker daemon available in the environment this was built in) — only the underlying Node.js code was run and tested directly
- ❌ **The dashboard (`shift-board-live.html`) does not know how to log into Keycloak.** This project only builds the *backend* half of Keycloak protection. The dashboard currently just does a plain `fetch()` with no Authorization header — it would need real changes (using Keycloak's JavaScript adapter, `keycloak-js`, to handle an actual login flow and attach a token to its requests) before it could talk to this backend at all. Treat this as an unfinished pair, not a drop-in replacement.

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

1. Point `KEYCLOAK_URL` and `KEYCLOAK_REALM` at whichever Keycloak instance you'll actually use in production — either one the client already runs, or one you stand up and manage
2. Build and push the Docker image to wherever it'll run (a container registry + your chosen hosting: Azure Container Apps, AWS Fargate, on-prem Docker/Kubernetes, etc.)
3. **Build the missing frontend piece** — updating `shift-board-live.html` to perform an actual Keycloak login before calling this API. This is real, separate work not included here.

## File Structure

```
shift-board-docker/
├── Dockerfile
├── docker-compose.yml       (includes a local Keycloak for testing)
├── .env.example
├── package.json
└── src/
    ├── server.js            (Express app, routes)
    ├── keycloak-auth.js     (JWT verification middleware)
    └── sprout.js            (Sprout HR integration — same logic as the Azure port)
```
