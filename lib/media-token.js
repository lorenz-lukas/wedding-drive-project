const crypto = require("node:crypto");

const DEFAULT_MEDIA_TOKEN_TTL_SECONDS = 10 * 60;
const MEDIA_TOKEN_ALGORITHM = "aes-256-gcm";
const MEDIA_TOKEN_VERSION = "v1";

function getMediaTokenSecret() {
  return String(process.env.MEDIA_TOKEN_SECRET || process.env.AUTH_TOKEN_SECRET || "").trim();
}

function getMediaTokenTtlSeconds() {
  const rawValue = Number(process.env.MEDIA_TOKEN_TTL_SECONDS || DEFAULT_MEDIA_TOKEN_TTL_SECONDS);
  if (!Number.isFinite(rawValue) || rawValue <= 0) {
    return DEFAULT_MEDIA_TOKEN_TTL_SECONDS;
  }
  return Math.max(60, Math.floor(rawValue));
}

function getEncryptionKey() {
  const secret = getMediaTokenSecret();
  if (!secret) {
    throw new Error("MEDIA_TOKEN_SECRET or AUTH_TOKEN_SECRET must be configured.");
  }

  return crypto.createHash("sha256").update(secret).digest();
}

function encodeBase64Url(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function decodeBase64Url(value) {
  const normalized = String(value || "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

function createMediaToken({ fileId, scope }) {
  const normalizedFileId = String(fileId || "").trim();
  const normalizedScope = String(scope || "").trim();
  if (!normalizedFileId || !normalizedScope) {
    throw new Error("fileId and scope are required to create a media token.");
  }

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(MEDIA_TOKEN_ALGORITHM, getEncryptionKey(), iv);
  const now = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({
    fileId: normalizedFileId,
    scope: normalizedScope,
    exp: now + getMediaTokenTtlSeconds()
  });

  const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return [
    MEDIA_TOKEN_VERSION,
    encodeBase64Url(iv),
    encodeBase64Url(encrypted),
    encodeBase64Url(authTag)
  ].join(".");
}

function readMediaToken(token, expectedScope) {
  const parts = String(token || "").split(".");
  if (parts.length !== 4 || parts[0] !== MEDIA_TOKEN_VERSION) {
    return null;
  }

  try {
    const iv = decodeBase64Url(parts[1]);
    const encrypted = decodeBase64Url(parts[2]);
    const authTag = decodeBase64Url(parts[3]);
    const decipher = crypto.createDecipheriv(MEDIA_TOKEN_ALGORITHM, getEncryptionKey(), iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
    const payload = JSON.parse(decrypted);
    const normalizedScope = String(expectedScope || "").trim();

    if (!payload?.fileId || !payload?.scope || !payload?.exp) {
      return null;
    }

    if (normalizedScope && payload.scope !== normalizedScope) {
      return null;
    }

    if (Number(payload.exp) < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return {
      fileId: String(payload.fileId),
      scope: String(payload.scope),
      exp: Number(payload.exp)
    };
  } catch {
    return null;
  }
}

module.exports = {
  createMediaToken,
  readMediaToken
};
