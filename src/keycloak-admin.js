/**
 * Shared Keycloak Admin REST API client.
 * -----------------------------------------------------------------------
 * Used by both scripts/onboard-admin-user.js (CLI) and the in-app
 * /api/admin/users endpoint (src/server.js) — same logic, two front doors.
 *
 * Authenticates as the "shift-board-admin-api" service account client
 * (client_credentials grant), not as any individual person's login.
 *
 * See the setup notes in scripts/onboard-admin-user.js for one-time
 * Keycloak configuration required before this works (regenerating the
 * service account's secret, confirming its realm-management roles).
 */

const KEYCLOAK_URL = process.env.KEYCLOAK_URL;
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM;
const ADMIN_CLIENT_ID = process.env.KEYCLOAK_ADMIN_CLIENT_ID || 'shift-board-admin-api';
const ADMIN_CLIENT_SECRET = process.env.KEYCLOAK_ADMIN_CLIENT_SECRET;
const ROLE_TO_ASSIGN = process.env.REQUIRED_ROLE || 'admin';

class KeycloakAdminError extends Error {}

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

function isConfigured() {
  return Boolean(KEYCLOAK_URL && KEYCLOAK_REALM && ADMIN_CLIENT_SECRET);
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
    throw new KeycloakAdminError(`Could not authenticate to Keycloak as "${ADMIN_CLIENT_ID}" (${res.status}). Check KEYCLOAK_URL/KEYCLOAK_REALM/KEYCLOAK_ADMIN_CLIENT_SECRET are correct. Response: ${body}`);
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
    throw new KeycloakAdminError(`A user named "${username}" (or with that email) already exists in Keycloak.`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new KeycloakAdminError(`Failed to create user (${res.status}). Response: ${body}`);
  }

  // Keycloak's create-user response doesn't return the new user's ID directly
  // — it comes back in the Location header of the response.
  const location = res.headers.get('Location');
  if (!location) throw new KeycloakAdminError('User was created, but Keycloak did not return a Location header to find their ID. Check the admin console manually.');
  return location.split('/').pop();
}

async function findRole(token, roleName) {
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/roles/${encodeURIComponent(roleName)}`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (res.status === 404) {
    throw new KeycloakAdminError(`Realm role "${roleName}" does not exist in Keycloak. Create it first (Realm roles → Create role), or check REQUIRED_ROLE matches what's actually in Keycloak.`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new KeycloakAdminError(`Failed to look up role "${roleName}" (${res.status}). Response: ${body}`);
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
    throw new KeycloakAdminError(`User was created, but assigning the "${role.name}" role failed (${res.status}). You'll need to assign it manually in Keycloak's admin console (Users → this user → Role mapping). Response: ${body}`);
  }
}

/**
 * Full onboarding flow: create the user, set a temporary password, assign
 * the admin role. Returns { username, password } on success — the caller
 * is responsible for getting that password to the new user securely.
 * Throws KeycloakAdminError with a message safe to show to the (already
 * admin-authenticated) person who triggered this.
 */
async function onboardUser({ username, email, firstName, lastName, password }) {
  if (!isConfigured()) {
    throw new KeycloakAdminError('Keycloak Admin API is not configured on the server (KEYCLOAK_URL / KEYCLOAK_REALM / KEYCLOAK_ADMIN_CLIENT_SECRET missing).');
  }
  const finalPassword = password || generatePassword();

  const token = await getAdminToken();
  const userId = await createUser(token, { username, email, firstName, lastName, password: finalPassword });
  const role = await findRole(token, ROLE_TO_ASSIGN);
  await assignRole(token, userId, role);

  return { username, password: finalPassword, role: ROLE_TO_ASSIGN };
}

/**
 * Lists existing users (id, username, email, enabled) — for showing in an
 * admin panel. Does not include role info per-user (a second API call per
 * user would be needed for that; kept out for now to keep this fast).
 */
async function listUsers() {
  if (!isConfigured()) {
    throw new KeycloakAdminError('Keycloak Admin API is not configured on the server (KEYCLOAK_URL / KEYCLOAK_REALM / KEYCLOAK_ADMIN_CLIENT_SECRET missing).');
  }
  const token = await getAdminToken();
  const res = await fetch(`${KEYCLOAK_URL}/admin/realms/${KEYCLOAK_REALM}/users?max=200`, {
    headers: { 'Authorization': `Bearer ${token}` }
  });
  if (!res.ok) {
    const body = await res.text();
    throw new KeycloakAdminError(`Failed to list users (${res.status}). Response: ${body}`);
  }
  const users = await res.json();
  return users.map((u) => ({
    id: u.id,
    username: u.username,
    email: u.email || '',
    firstName: u.firstName || '',
    lastName: u.lastName || '',
    enabled: u.enabled
  }));
}

module.exports = {
  KeycloakAdminError,
  isConfigured,
  generatePassword,
  getAdminToken,
  createUser,
  findRole,
  assignRole,
  onboardUser,
  listUsers,
  ROLE_TO_ASSIGN
};
