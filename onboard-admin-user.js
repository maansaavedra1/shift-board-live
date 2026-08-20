#!/usr/bin/env node
/**
 * CLI wrapper for onboarding a Shift Board dashboard user via Keycloak's
 * Admin REST API — the actual logic lives in src/keycloak-admin.js, shared
 * with the in-app "Add User" panel (see /api/admin/users in server.js).
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
 *
 * NOTE: as of this version, adding users can also be done directly from
 * the dashboard itself (an "Add User" panel — see public/index.html) if
 * the app is deployed and you're already logged in as an admin. This
 * script remains useful for bulk onboarding, automation, or if the app
 * itself isn't reachable for some reason.
 */

const { onboardUser, KeycloakAdminError } = require('../src/keycloak-admin');

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

async function main() {
  const [username, email, firstName, lastName, password] = process.argv.slice(2);

  if (!username || !email || !firstName || !lastName) {
    console.log('Usage: node scripts/onboard-admin-user.js <username> <email> <firstName> <lastName> [temporaryPassword]');
    process.exit(1);
  }

  console.log(`Onboarding "${username}"...`);
  const result = await onboardUser({ username, email, firstName, lastName, password });

  console.log('');
  console.log('Done. Share these with the new user through a secure channel:');
  console.log(`  Username: ${result.username}`);
  console.log(`  Temporary password: ${result.password}`);
  console.log(`  Role assigned: ${result.role}`);
  console.log('  (They will be required to set their own password on first login.)');
}

main().catch((err) => {
  if (err instanceof KeycloakAdminError) {
    fail(err.message);
  } else {
    fail(err.message || String(err));
  }
});
