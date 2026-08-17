/**
 * Keycloak authentication middleware.
 * -----------------------------------------------------------------------------
 * Verifies a Bearer token (a JWT issued by Keycloak) on incoming requests,
 * instead of the shared-secret-key approach used in the Apps Script / Azure
 * versions. This means real user logins, not a single shared URL+key.
 *
 * IMPORTANT — this only protects the BACKEND. The dashboard
 * (shift-board-live.html) does NOT currently know how to log a user into
 * Keycloak and obtain a token to send here — that's a separate, real piece
 * of frontend work not yet built. Right now, this middleware would reject
 * every request from the existing dashboard, since it never sends an
 * Authorization header at all. Treat this as the backend half of a two-part
 * change, not a drop-in replacement on its own.
 *
 * How it works:
 * 1. Client sends "Authorization: Bearer <token>"
 * 2. This middleware fetches Keycloak's public signing keys (JWKS) and
 *    verifies the token's signature, issuer, and expiry
 * 3. If valid, the request proceeds; if not, it's rejected with 401
 */

const jwt = require('jsonwebtoken');
const jwksClient = require('jwks-rsa');

const KEYCLOAK_URL = process.env.KEYCLOAK_URL; // e.g. https://your-keycloak.example.com
const KEYCLOAK_REALM = process.env.KEYCLOAK_REALM; // e.g. shift-board
const KEYCLOAK_AUDIENCE = process.env.KEYCLOAK_AUDIENCE; // optional — the expected "aud" claim, if configured in Keycloak

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
    req.user = decoded; // available to route handlers if you want to log who accessed what
    next();
  });
}

module.exports = { requireAuth };
