/**
 * Keycloak authentication + authorization middleware.
 * -----------------------------------------------------------------------------
 * Two layers, both enforced by requireAuth:
 * 1. AUTHENTICATION — verifies a Bearer token (a JWT issued by Keycloak) on
 *    incoming requests, instead of the shared-secret-key approach used in
 *    the Apps Script / Azure versions.
 * 2. AUTHORIZATION — checks the token actually carries the required realm
 *    role (default: "admin", set via REQUIRED_ROLE below) before letting
 *    the request through. Being logged into Keycloak is not enough on its
 *    own; the account also needs this role assigned in Keycloak.
 *
 * How it works:
 * 1. Client sends "Authorization: Bearer <token>"
 * 2. This middleware fetches Keycloak's public signing keys (JWKS) and
 *    verifies the token's signature, issuer, and expiry
 * 3. If valid, it checks decoded.realm_access.roles for REQUIRED_ROLE
 * 4. If the token is invalid → 401. If it's valid but missing the role → 403.
 *
 * To onboard someone: in Keycloak's admin console, go to
 * Users → (their account) → Role mapping → Assign role → pick the role
 * named in REQUIRED_ROLE (default "admin"). Just creating the user account
 * is not enough — this step is what actually grants dashboard access.
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const KEYCLOAK_URL = process.env.KEYCLOAK_URL; // e.g. https://your-keycloak.example.com
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM; // e.g. shift-board
const KEYCLOAK_AUDIENCE = process.env.KEYCLOAK_AUDIENCE; // optional — the expected "aud" claim, if configured in Keycloak

// The realm role required to access the dashboard. Set REQUIRED_ROLE=""
// (empty) to disable the role check entirely and fall back to "any logged
// in user can access it" — not recommended once real users are onboarded,
// but useful while first wiring things up.
const REQUIRED_ROLE = process.env.REQUIRED_ROLE !== undefined ? process.env.REQUIRED_ROLE : 'admin';

const client = KEYCLOAK_URL && KEYCLOAK_REALM
  ? jwksClient({
      jwksUri: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}/protocol/openid-connect/certs`,
      cache: true,
      cacheMaxAge: 10 * 60 * 1000 // 10 minutes
    })
  : null;

function getSigningKey(header, callback) {
  client.getSigningKey(header.kid, (err, key) => {
    if (err) return callback(err);
    callback(null, key.getPublicKey());
  });
}

function hasRequiredRole(decoded) {
  if (!REQUIRED_ROLE) return true; // role check disabled
  const realmRoles = (decoded.realm_access && decoded.realm_access.roles) || [];
  return realmRoles.includes(REQUIRED_ROLE);
}

function requireAuth(req, res, next) {
  if (!client) {
    return res.status(500).json({
      ok: false,
      error: 'Keycloak is not configured (KEYCLOAK_URL / KEYCLOAK_REALM missing). Set these environment variables to enable authentication.'
    });
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;

  if (!token) {
    return res.status(401).json({ ok: false, error: 'Missing Authorization: Bearer token.' });
  }

  const verifyOptions = {
    issuer: `${KEYCLOAK_URL}/realms/${KEYCLOAK_REALM}`
  };
  if (KEYCLOAK_AUDIENCE) verifyOptions.audience = KEYCLOAK_AUDIENCE;

  jwt.verify(token, getSigningKey, verifyOptions, (err, decoded) => {
    if (err) {
      return res.status(401).json({ ok: false, error: `Invalid token: ${err.message}` });
    }

    if (!hasRequiredRole(decoded)) {
      return res.status(403).json({
        ok: false,
        error: `You're signed in, but your account doesn't have the "${REQUIRED_ROLE}" role needed to view this dashboard. Ask an admin to grant it in Keycloak (Users → your account → Role mapping).`
      });
    }

    req.user = decoded; // available to route handlers if you want to log who accessed what
    next();
  });
}

module.exports = { requireAuth };
