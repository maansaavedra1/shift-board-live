#!/usr/bin/env node
/**
 * Generates a new, isolated Keycloak realm file for one tenant/client,
 * as part of the "fully separate deployment per client" multi-tenant
 * pattern — see MULTI_TENANT_DEPLOYMENT.md for the full picture.
 *
 * Each tenant gets:
 *   - Their own realm name (e.g. "shift-board-acme")
 *   - Their own randomly generated admin-api client secret (NOT the
 *     shared placeholder in the template — each tenant gets a unique one,
 *     so a leak on one tenant's deployment can't be reused against another)
 *   - The same role/test-user structure as the base template
 *
 * This only touches the realm JSON. It does NOT create any infrastructure
 * — you still deploy a separate Container App + Keycloak instance/realm +
 * Sprout credentials per tenant, following AZURE_DEPLOYMENT.md once per
 * client. This script just removes the manual, error-prone JSON editing
 * and placeholder-secret risk from that process.
 *
 * -----------------------------------------------------------------------
 * USAGE
 * -----------------------------------------------------------------------
 *   node scripts/generate-tenant-realm.js <tenant-slug>
 *
 * Example:
 *   node scripts/generate-tenant-realm.js acme
 *
 * Produces: keycloak/tenants/shift-board-acme-realm.json
 *
 * <tenant-slug> should be short, lowercase, hyphen-safe (e.g. "acme",
 * "my-offshore") — it becomes part of the realm name and the output
 * filename.
 *
 * Requires Node 16+ (uses the built-in crypto module — no dependencies).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEMPLATE_PATH = path.join(__dirname, '..', 'keycloak', 'shift-board-realm.json');
const OUTPUT_DIR = path.join(__dirname, '..', 'keycloak', 'tenants');

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function generateSecret() {
  // 32 random bytes, base64url-encoded — well above what Keycloak needs
  // for a confidential client secret.
  return crypto.randomBytes(32).toString('base64url');
}

function main() {
  const slug = process.argv[2];

  if (!slug) {
    console.log('Usage: node scripts/generate-tenant-realm.js <tenant-slug>');
    console.log('Example: node scripts/generate-tenant-realm.js acme');
    process.exit(1);
  }

  if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    fail(`"${slug}" is not a valid slug — use lowercase letters, numbers, and hyphens only (e.g. "acme", "my-offshore").`);
  }

  if (!fs.existsSync(TEMPLATE_PATH)) {
    fail(`Could not find the base template at ${TEMPLATE_PATH}.`);
  }

  const template = JSON.parse(fs.readFileSync(TEMPLATE_PATH, 'utf8'));
  const realmName = `shift-board-${slug}`;
  const adminApiSecret = generateSecret();

  // Deep-ish clone via JSON round-trip is fine here — the template has no
  // functions/dates, just plain data.
  const tenantRealm = JSON.parse(JSON.stringify(template));
  tenantRealm.realm = realmName;

  const adminApiClient = tenantRealm.clients.find((c) => c.clientId === 'shift-board-admin-api');
  if (!adminApiClient) {
    fail('Could not find the "shift-board-admin-api" client in the template — has shift-board-realm.json been restructured?');
  }
  adminApiClient.secret = adminApiSecret;

  // Remove the two test accounts for real tenants — they're useful for
  // local dev against the base template, not for an actual client realm.
  tenantRealm.users = tenantRealm.users.filter(
    (u) => u.username !== 'testuser' && u.username !== 'testuser-noaccess'
  );

  if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const outputPath = path.join(OUTPUT_DIR, `${realmName}-realm.json`);
  if (fs.existsSync(outputPath)) {
    fail(`${outputPath} already exists. Delete it first if you really want to regenerate this tenant (this would issue a new admin-api secret, invalidating the old one).`);
  }

  fs.writeFileSync(outputPath, JSON.stringify(tenantRealm, null, 2) + '\n');

  console.log(`Created ${outputPath}`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Import this file into a NEW Keycloak realm (or a new, separate Keycloak instance for max isolation).`);
  console.log(`  2. Deploy a separate copy of the app (AZURE_DEPLOYMENT.md), with env vars for this tenant:`);
  console.log(`       KEYCLOAK_REALM=${realmName}`);
  console.log(`       KEYCLOAK_ADMIN_CLIENT_SECRET=${adminApiSecret}`);
  console.log(`       (plus this tenant's own SPROUT_* credentials, and their own custom domain)`);
  console.log('  3. Use scripts/onboard-admin-user.js (pointed at this tenant\'s KEYCLOAK_REALM) to add their users.');
  console.log('');
  console.log('This secret is only shown here and saved in the output file — store it in a password manager or secrets vault, not in chat or email.');
}

main();
