#!/usr/bin/env node
/**
 * Onboards a Shift Board dashboard user via Keycloak's Admin REST API,
 * instead of manually clicking through Keycloak's admin console.
 *
 * This does three things in sequence:
 * 1. Creates the user account in Keycloak
 * 2. Sets their initial password (marked "temporary" — they'll be forced
 *    to change it on first login)
 * 3. Assigns the "admin" realm role to them, which is what actually grants
 *    dashboard access (see keycloak-auth.js / REQUIRED_ROLE) — creating
 *    the account alone does NOT grant access, same as doing this manually.
 *
 * -----------------------------------------------------------------------
 * ONE-TIME SETUP — before running this script the first time:
 * -----------------------------------------------------------------------
 * This script authenticates to Keycloak as the "shift-board-admin-api"
 * service account client (already defined in shift-board-realm.json if
 * you imported that file). Before using this for real:
 *
 *   1. In Keycloak's admin console, go to Clients → shift-board-admin-api
 *      → Credentials tab → click "Regenerate" to get a fresh secret.
 *      DO NOT use the placeholder secret shipped in shift-board-realm.json
 *      for anything beyond local testing — that value is public, it's
 *      sitting in this repo.
 *   2. Put that fresh secret in your .env file as KEYCLOAK_ADMIN_CLIENT_SECRET
 *   3. Confirm the service account has the "manage-users" and "view-users"
 *      realm-management roles (Clients → shift-board-admin-api →
 *      Service account roles) — already set up if you imported the realm
 *      file as-is and didn't change it.
 *
 * -----------------------------------------------------------------------
 * USAGE
 * -----------------------------------------------------------------------
 *   node scripts/onboard-admin-user.js <username> <email> <firstName> <lastName> [temporaryPassword]
 *
 * Example:
 *   node scripts/onboard-admin-user.js jdelacruz jdelacruz@sprout.ph Juan "Dela Cruz"
 *
 * If you don't pass a temporary password, one is generated and printed —
 * share it with the person through a secure channel (not email/chat in
 * plain text if you can avoid it), and they'll be required to set their
 * own password on first login.
 *
 * Requires Node 18+ (uses the built-in fetch — no extra dependencies).
 */

const KEYCLOAK_URL = process.env.KEYCLOAK_URL;
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM;
const ADMIN_CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'shift-board-admin-api';
const ADMIN_CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
const ROLE_TO_ASSIGN = process.env.REQUIRED_ROLE || 'admin';

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function generatePassword() {
  // Not cryptographically exotic, just needs to be unguessable and pass
  // Keycloak's default password policy. The person resets it on first
  // login anyway (see `temporary: true` below).
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%';
  let pw = '';
  for (let i = 0; i < 16; i++) {
    pw += chars[Math.floor(Math.random() * chars.length)];
  }
  return pw;
}

async function getAdminToken() {
  const res = await fetch(`${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: ADMIN_CLIENT_ID,
      client_secret: ADMIN_CLIENT_SECRET
    })
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`Could not authenticate to Keycloak as "${ADMIN_CLIENT_ID}" (${res.status}). Check KEYCLOAK_URL/KEYCLOAK_REALM/KEYCLOAK_ADMIN_CLIENT_SECRET are correct. Response: ${body}`);
  }
  const data = await res.json();
  return data.access_token;
}

async function createUser(token, { username, email, firstName, lastName, password }) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      username,
      email,
      firstName,
      lastName,
      enabled: true,
      emailVerified: false,
      credentials: [
        { type: 'password', value: password, temporary: true }
      ]
    })
  });

  if (res.status === 409) {
    fail(`A user named "${username}" (or with that email) already exists in Keycloak. Use Keycloak's admin console to update an existing user instead — this script only creates new ones.`);
  }
  if (!res.ok) {
    const body = await res.text();
    fail(`Failed to create user (${res.status}). Response: ${body}`);
  }

  // Keycloak's create-user response doesn't return the new user's ID directly
  // — it comes back in the Location header of the response.
  const location = res.headers.get('Location');
  if (!location) fail('User was created, but Keycloak did not return a Location header to find their ID. Check the admin console manually.');
  return location.split('/').pop();
}

async function findRole(token, roleName) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/roles/${encodeURIComponent(roleName)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status === 404) {
    fail(`Realm role "${roleName}" does not exist in Keycloak. Create it first (Realm roles → Create role), or check REQUIRED_ROLE matches what's actually in Keycloak.`);
  }
  if (!res.ok) {
    const body = await res.text();
    fail(`Failed to look up role "${roleName}" (${res.status}). Response: ${body}`);
  }
  return res.json(); // { id, name, ... }
}

async function assignRole(token, userId, role) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users/${userId}/role-mappings/realm`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify([{ id: role.id, name: role.name }])
  });
  if (!res.ok) {
    const body = await res.text();
    fail(`User was created, but assigning the "${role.name}" role failed (${res.status}). You'll need to assign it manually in Keycloak's admin console (Users → this user → Role mapping). Response: ${body}`);
  }
}

async function main() {
  const [username, email, firstName, lastName, passedPassword] = process.argv.slice(2);

  if (!username || !email || !firstName || !lastName) {
    console.log('Usage: node scripts/onboard-admin-user.js <username> <email> <firstName> <lastName> [temporaryPassword]');
    process.exit(1);
  }
  if (!KEYCLOAK_URL || !KEYCLOAK_REALM) {
    fail('KEYCLOAK_URL and KEYCLOAK_REALM must be set (e.g. in your .env file, then run this with `node --env-file=.env scripts/onboard-admin-user.js ...` on Node 20+, or export them in your shell first).');
  }
  if (!ADMIN_CLIENT_SECRET) {
    fail('KEYCLOAK_ADMIN_CLIENT_SECRET is not set. See the setup notes at the top of this script.');
  }

  const password = passedPassword || generatePassword();

  console.log(`Authenticating to Keycloak as "${ADMIN_CLIENT_ID}"...`);
  const token = await getAdminToken();

  console.log(`Creating user "${username}"...`);
  const userId = await createUser(token, { username, email, firstName, lastName, password });

  console.log(`Looking up the "${ROLE_TO_ASSIGN}" role...`);
  const role = await findRole(token, ROLE_TO_ASSIGN);

  console.log(`Assigning "${ROLE_TO_ASSIGN}" role to "${username}"...`);
  await assignRole(token, userId, role);

  console.log('');
  console.log('Done. Share these with the new user through a secure channel:');
  console.log(`  Username: ${username}`);
  console.log(`  Temporary password: ${password}`);
  console.log('  (They will be required to set their own password on first login.)');
}

main().catch((err) => fail(err.message || String(err)));
