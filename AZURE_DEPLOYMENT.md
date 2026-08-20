# Deploying Shift Board (Docker + Keycloak) to Azure

This covers taking the reference implementation in this repo and actually
running it on Azure. It assumes **Azure Container Apps** as the target,
since it's the simplest fit for two small stateless-ish containers
(Shift Board backend+frontend, and Keycloak) without managing VMs.

If your org already runs Kubernetes (AKS), the same two container images
work there too — swap the `az containerapp` steps below for a Deployment +
Service + Ingress manifest instead.

## Before you start — two things this repo does NOT include

1. **A production-grade Keycloak.** The `keycloak` service in
   `docker-compose.yml` runs `start-dev` with Keycloak's built-in H2
   database — fine for local testing, **not safe for production** (data
   isn't durable, and `start-dev` disables some security hardening). For
   Azure, either:
   - Point at a Keycloak instance the client already operates, or
   - Stand up your own production Keycloak backed by a real database
     (steps below use Azure Database for PostgreSQL Flexible Server)

2. **TLS/HTTPS termination.** Everything here is written assuming Azure
   Container Apps' built-in ingress (which provisions HTTPS automatically
   on the `*.azurecontainerapps.io` domain, or on a custom domain you
   attach). If you deploy differently, you're responsible for TLS yourself
   — Keycloak in particular should never be exposed over plain HTTP in
   production.

## Architecture

```
                         ┌─────────────────────────────┐
   Browser  ───HTTPS───▶ │  Container App: shift-board │
                         │  (Express: serves index.html │
                         │   + /api/shift-board,        │
                         │   verifies Keycloak JWTs)     │
                         └───────────────┬──────────────┘
                                         │ validates tokens against
                                         │ Keycloak's public JWKS
                                         ▼
                         ┌─────────────────────────────┐
                         │  Container App: keycloak     │
                         └───────────────┬──────────────┘
                                         │
                                         ▼
                         ┌─────────────────────────────┐
                         │ Azure DB for PostgreSQL      │
                         │ Flexible Server (Keycloak's   │
                         │ persistent storage)           │
                         └─────────────────────────────┘
```

## Step 1 — Resource group, registry, and Postgres for Keycloak

```bash
az group create --name shift-board-rg --location southeastasia

az acr create --resource-group shift-board-rg \
  --name shiftboardacr --sku Basic

az postgres flexible-server create \
  --resource-group shift-board-rg \
  --name shiftboard-keycloak-db \
  --admin-user kcadmin \
  --admin-password '<choose a strong password>' \
  --sku-name Standard_B1ms \
  --tier Burstable \
  --version 15 \
  --database-name keycloak
```

## Step 2 — Build and push the Shift Board image

```bash
az acr login --name shiftboardacr

docker build -t shiftboardacr.azurecr.io/shift-board:latest .
docker push shiftboardacr.azurecr.io/shift-board:latest
```

## Step 3 — Container Apps environment

```bash
az extension add --name containerapp --upgrade

az containerapp env create \
  --name shift-board-env \
  --resource-group shift-board-rg \
  --location southeastasia
```

## Step 4 — Deploy Keycloak (production mode, pointed at Postgres)

```bash
az containerapp create \
  --name keycloak \
  --resource-group shift-board-rg \
  --environment shift-board-env \
  --image quay.io/keycloak/keycloak:25.0 \
  --target-port 8080 \
  --ingress external \
  --min-replicas 1 --max-replicas 1 \
  --command "/opt/keycloak/bin/kc.sh" "start" \
  --env-vars \
    KC_DB=postgres \
    KC_DB_URL="jdbc:postgresql://shiftboard-keycloak-db.postgres.database.azure.com:5432/keycloak" \
    KC_DB_USERNAME=kcadmin \
    KC_DB_PASSWORD="<same password as Step 1>" \
    KC_HOSTNAME_STRICT=false \
    KC_PROXY=edge \
    KEYCLOAK_ADMIN=admin \
    KEYCLOAK_ADMIN_PASSWORD="<choose a strong admin password — not admin/admin>"
```

`--min-replicas 1` matters here: Keycloak with `start` (not `start-dev`)
expects to run stably, and scaling to zero would log everyone out and
briefly break the login flow while it cold-starts.

Note the URL Azure gives this app (`https://keycloak.<random>.azurecontainerapps.io`)
— you'll need it in Steps 5 and 6.

**Import the realm:** log into the Keycloak admin console at that URL,
go to Realm settings → Import, and upload `keycloak/shift-board-realm.json` from
this repo. This creates the `shift-board` realm, the `shift-board-app`
public client, and (if you kept it) the `testuser` test account — delete
that test user before going live.

**Fix the client's redirect URIs and web origins**: `keycloak/shift-board-realm.json`
ships with `redirectUris: ["*"]` and `webOrigins: ["*"]` for local testing.
Before production, edit the `shift-board-app` client in Keycloak's admin
console and lock these down to your actual Shift Board URL (from Step 6),
e.g. `https://shiftboard.<random>.azurecontainerapps.io/*`.

**Regenerate the admin-api client's secret.** The realm file also creates
a second, confidential client called `shift-board-admin-api` — this is
what powers both `scripts/onboard-admin-user.js` and the dashboard's
in-app "manage users" panel. It ships with a placeholder secret
(`CHANGE_ME_LOCAL_TESTING_ONLY`) that's sitting in this repo, so it must
never be used as-is beyond local testing:

1. Keycloak admin console → **Clients** → `shift-board-admin-api` → **Credentials** tab
2. Click **Regenerate secret**
3. Copy the new value — you'll need it in Step 5 below

## Step 5 — Deploy the Shift Board backend+frontend

```bash
az containerapp create \
  --name shift-board \
  --resource-group shift-board-rg \
  --environment shift-board-env \
  --image shiftboardacr.azurecr.io/shift-board:latest \
  --target-port 3000 \
  --ingress external \
  --min-replicas 1 --max-replicas 2 \
  --registry-server shiftboardacr.azurecr.io \
  --secrets \
    sprout-client-secret="<real value>" \
    sprout-subscription-key="<real value>" \
    keycloak-admin-client-secret="<the secret you just regenerated>" \
  --env-vars \
    SPROUT_BASE=https://gateway-sb.sprout.ph \
    SPROUT_CLIENT_ID="<real value>" \
    SPROUT_CLIENT_SECRET=secretref:sprout-client-secret \
    SPROUT_SUBSCRIPTION_KEY=secretref:sprout-subscription-key \
    SPROUT_USER_ID="<real value>" \
    KEYCLOAK_URL="https://keycloak.<random>.azurecontainerapps.io" \
    KEYCLOAK_REALM=shift-board \
    KEYCLOAK_CLIENT_ID=shift-board-app \
    KEYCLOAK_ADMIN_CLIENT_ID=shift-board-admin-api \
    KEYCLOAK_ADMIN_CLIENT_SECRET=secretref:keycloak-admin-client-secret
```

`KEYCLOAK_ADMIN_CLIENT_ID` / `KEYCLOAK_ADMIN_CLIENT_SECRET` are what let the
dashboard's "manage users" panel (and the CLI script) call Keycloak's
Admin API. If these are left unset, the panel won't crash — it shows a
clear "not configured" message instead — but nobody will be able to add
users through the app until they're set.

Azure's built-in health probes will hit `/` by default; you can point the
liveness probe at `/health` explicitly in the Azure Portal under the
Container App's Health probes settings, matching the `HEALTHCHECK` already
defined in the Dockerfile.

## Step 6 — Point the dashboard at the real Keycloak URL

The frontend fetches its Keycloak connection details from the backend's
`/config.json` endpoint at runtime, which reads them straight from the
`KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` environment
variables set in Step 5 — **no code edit or image rebuild needed here.**
If Keycloak's URL ever changes later (new domain, moved instance, etc.),
just update the env var on the `shift-board` Container App and restart it:

```bash
az containerapp update --name shift-board --resource-group shift-board-rg \
  --set-env-vars KEYCLOAK_URL="https://your-new-keycloak-url"
```

## Step 7 — Custom domain (optional but recommended)

```bash
az containerapp hostname add \
  --hostname shiftboard.yourcompany.com \
  --name shift-board \
  --resource-group shift-board-rg
```

Follow the CNAME/TXT record instructions Azure gives you, then bind a
managed certificate through the Portal (Container App → Custom domains →
Add certificate). Do the same for Keycloak if you want it on your own
domain rather than the default `azurecontainerapps.io` one — and if you
change Keycloak's URL, update the `KEYCLOAK_URL` environment variable on
the `shift-board` Container App (same command as Step 6) to match.

## What to actually test before calling this "done"

This closes the gaps the original README flagged, but confirm all of
these against your real Azure deployment — none of it has been run
end-to-end outside this session:

- [ ] Loading the dashboard URL redirects to Keycloak's login page
- [ ] Logging in with a real user returns you to the dashboard and it
      loads live Sprout data (not a 401)
- [ ] Sitting on the dashboard past the access token's expiry (default
      5 min in Keycloak) still works — confirms `getFreshToken()`'s
      silent refresh is working, not just the initial login
- [ ] Signing out actually clears the session (reload shouldn't silently
      log you back in)
- [ ] Hitting `/api/shift-board` directly with `curl` and no token
      returns 401
- [ ] The `/health` endpoint is reachable without a token (confirms
      Container Apps' health probe won't itself get blocked by auth)
- [ ] A second browser/incognito session, never logged in, is correctly
      forced through login too (not just relying on a cached session)
- [ ] Logging in as `testuser-noaccess` (correct login, no `admin` role)
      gets a clear 403 message on the dashboard instead of either silently
      failing or being let through
- [ ] Clicking "manage users" in the dashboard toolbar opens the panel and
      successfully lists existing Keycloak users (confirms
      `KEYCLOAK_ADMIN_CLIENT_SECRET` is set and correct)
- [ ] Adding a user through that panel actually creates them in Keycloak
      (verify in Keycloak's own admin console, not just the app's success
      message) — and confirm they land in the `admin` role automatically
- [ ] The newly added user can log in with the temporary password shown
      and is prompted to set their own on first login
