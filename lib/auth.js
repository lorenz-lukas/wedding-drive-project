const crypto = require("node:crypto");
const { createLogger } = require("./_logger");

const logger = createLogger("auth");

const DEFAULT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function getAuthConfig() {
  return {
    username: process.env.GALLERY_USER,
    password: process.env.GALLERY_PASSWORD,
    tokenSecret: String(process.env.AUTH_TOKEN_SECRET || "").trim(),
    tokenTtlSeconds: Number(process.env.AUTH_TOKEN_TTL_SECONDS || DEFAULT_TOKEN_TTL_SECONDS)
  };
}

function hasConfiguredTokenSecret() {
  return Boolean(getAuthConfig().tokenSecret);
}

function requireConfiguredTokenSecret() {
  const { tokenSecret } = getAuthConfig();
  if (!tokenSecret) {
    throw new Error("AUTH_TOKEN_SECRET is not configured.");
  }
  return tokenSecret;
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function signPayload(payload, tokenSecret) {
  return crypto
    .createHmac("sha256", tokenSecret)
    .update(payload)
    .digest("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function validateCredentials(username, password) {
  const config = getAuthConfig();
  const normalizedInputUser = String(username || "").trim().toLowerCase();
  const normalizedConfigUser = String(config.username || "").trim().toLowerCase();
  return normalizedInputUser === normalizedConfigUser && password === config.password;
}

function createSessionToken(username) {
  const { tokenTtlSeconds } = getAuthConfig();
  const tokenSecret = requireConfiguredTokenSecret();
  const now = Math.floor(Date.now() / 1000);
  const payloadObject = {
    sub: username,
    iat: now,
    exp: now + Math.max(60, tokenTtlSeconds)
  };

  const encodedPayload = encodeBase64Url(JSON.stringify(payloadObject));
  const signature = signPayload(encodedPayload, tokenSecret);

  return `${encodedPayload}.${signature}`;
}

function parseSessionToken(token) {
  if (!token || !token.includes(".")) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const tokenSecret = getAuthConfig().tokenSecret;
  if (!tokenSecret) {
    return null;
  }
  const expectedSignature = signPayload(encodedPayload, tokenSecret);

  if (signature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(decodeBase64Url(encodedPayload));
  } catch {
    return null;
  }

  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) {
    return null;
  }

  return payload;
}

function getTokenFromRequest(req) {
  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    return authHeader.slice(7).trim();
  }
  return "";
}

function requireAuth(req, res) {
  if (!hasConfiguredTokenSecret()) {
    logger.error("Authentication unavailable because AUTH_TOKEN_SECRET is missing", {
      method: req.method,
      path: req.url
    });
    res.status(503).json({ error: "Autenticacao indisponivel." });
    return null;
  }

  const token = getTokenFromRequest(req);
  const payload = parseSessionToken(token);

  if (!payload) {
    logger.warn("Authentication failed", {
      method: req.method,
      path: req.url,
      hasAuthorizationHeader: Boolean(req.headers.authorization)
    });
    res.status(401).json({ error: "Nao autenticado." });
    return null;
  }

  logger.info("Authentication succeeded", {
    method: req.method,
    path: req.url,
    username: payload.sub
  });
  return payload;
}

module.exports = {
  createSessionToken,
  hasConfiguredTokenSecret,
  requireAuth,
  validateCredentials
};
