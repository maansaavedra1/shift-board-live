# Multi-Tenant Deployment (Fully Isolated, Separate Login/URL Per Client)

This covers running Shift Board for **multiple clients, each fully
isolated from the others** — separate login page, separate URL, separate
Keycloak realm, separate Sprout HR credentials. No client can ever see
another client's users or data, because nothing is shared between them
except the code itself.

## Why this needs no new application code

Every client-specific value in this app already comes from environment
variables, not hardcoded config:

- `KEYCLOAK_URL` / `KEYCLOAK_REALM` / `KEYCLOAK_CLIENT_ID` — which login
  system a deployment talks to
- `SPROUT_CLIENT_ID` / `SPROUT_CLIENT_SECRET` / etc. — whose HR data it pulls
- `REQUIRED_ROLE` — which role gates access (can differ per tenant if you want)

This means "isolated per client" is a **deployment pattern**, not a new
feature: run the exact same Docker image multiple times, once per client,
each with its own set of environment variables and its own domain.

```
clienta.shiftboard.yourcompany.com  →  Container App "shift-board-clienta"
                                        → KEYCLOAK_REALM=shift-board-clienta
                                        → Client A's Sprout credentials

clientb.shiftboard.yourcompany.com  →  Container App "shift-board-clientb"
                                        → KEYCLOAK_REALM=shift-board-clientb
                                        → Client B's Sprout credentials
```

Each of these is deployed by following `AZURE_DEPLOYMENT.md` **once per
client**, end to end. Nothing in that guide changes — you're just running
it multiple times with different values.

## Two isolation levels to choose from

**Option 1 — Separate realm, same Keycloak server.** One Keycloak
instance hosts multiple realms (`shift-board-clienta`, `shift-board-clientb`,
etc.). Simpler to operate (one Keycloak to patch/monitor), and Keycloak
realms are already designed to fully wall off users/roles/sessions from
each other. Good default unless a client specifically requires their
login system to be on entirely separate infrastructure.

**Option 2 — Separate Keycloak instance per client.** Maximum isolation —
even Keycloak itself is a different container/database per client. Costs
more (a Postgres + Keycloak Container App per client instead of per
realm), but means a Keycloak-level incident on one client's instance
can't touch another's at all. Consider this if a client's contract
requires dedicated infrastructure, not just logical separation.

Either way, the app-side steps below are identical — you're just deciding
what `KEYCLOAK_URL` points to.

## Onboarding a new client, step by step

### 1. Generate their realm file

```bash
node scripts/generate-tenant-realm.js acme
```

This creates `keycloak/tenants/shift-board-acme-realm.json` — a copy of
the base realm template, but with:
- Its own realm name (`shift-board-acme`)
- A freshly, randomly generated secret for the `shift-board-admin-api`
  service account client (not the shared placeholder — each tenant gets
  a unique one, so a leak on one client's deployment can't be reused
  against another)
- The `testuser` / `testuser-noaccess` demo accounts removed (those are
  for local dev against the base template, not real client realms)

The script prints the generated secret once — save it in a password
manager or secrets vault immediately. It's also saved in the output JSON
file, so treat that file as a secret too (don't commit it to a public
repo; see the note at the bottom of this guide).

### 2. Set up their Keycloak realm

- **Option 1 (shared Keycloak server):** In your existing Keycloak admin
  console, go to **Add realm** first (top-left realm dropdown), name it
  `shift-board-acme`, then import `shift-board-acme-realm.json` into it.
- **Option 2 (dedicated Keycloak instance):** Follow `AZURE_DEPLOYMENT.md`
  Step 4 to stand up a new Keycloak Container App + Postgres for this
  client specifically, then import the realm file there.

### 3. Deploy their app instance

Follow `AZURE_DEPLOYMENT.md` Steps 1–7, using:
- A new Container App name, e.g. `shift-board-acme`
- `KEYCLOAK_REALM=shift-board-acme`
- `KEYCLOAK_URL` pointing at whichever Keycloak (shared or dedicated) you set up in Step 2
- This client's own `SPROUT_*` credentials
- A subdomain like `acme.shiftboard.yourcompany.com` (Step 7)

### 4. Onboard their users

```bash
KEYCLOAK_REALM=shift-board-acme \
KEYCLOAK_ADMIN_CLIENT_SECRET=<the secret from step 1> \
node scripts/onboard-admin-user.js jdelacruz jdelacruz@acme.com Juan "Dela Cruz"
```

(Or export those as part of a client-specific `.env.acme` file and load
it before running the script.)

## What to double check once it's running

- [ ] Logging into `clienta.shiftboard.yourcompany.com` only ever shows
      Client A's Keycloak login — never Client B's
- [ ] A user account created in Client A's realm cannot log into Client
      B's URL at all (different realm = Keycloak rejects it outright,
      but confirm this rather than assuming it)
- [ ] Client A's dashboard only ever shows Client A's Sprout HR data —
      confirm the `SPROUT_*` env vars on each Container App are genuinely
      different, not accidentally copy-pasted from one to the other
- [ ] Each client's `shift-board-admin-api` secret is different (the
      generator script handles this automatically — just don't reuse an
      old tenant's `.env` file as a starting point for a new one without
      changing the secret)

## A note on secrets in tenant realm files

`keycloak/tenants/*-realm.json` files contain a real, working client
secret once generated. Treat these the same as any other credential file:

- Don't commit them to a shared/public repository as-is
- If your repo is genuinely private and access-controlled, and your team
  already treats the repo itself as a secrets boundary (as this project
  currently does with the placeholder secret in the base template), that
  may be acceptable — but it's worth a deliberate decision, not a
  default. Consider a `.gitignore` entry for `keycloak/tenants/` and
  distributing those files through your secrets vault instead if you
  want a firmer boundary.
