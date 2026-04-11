const DEFAULT_CLEANUP_INTERVAL_MS = 60 * 1000;
const entries = new Map();

let nextCleanupAt = 0;

function getClientIp(req) {
  const forwardedFor = String(
    req.headers["x-forwarded-for"] ||
      req.headers["x-real-ip"] ||
      req.headers["x-vercel-forwarded-for"] ||
      ""
  ).trim();

  if (forwardedFor) {
    return forwardedFor.split(",")[0].trim();
  }

  return String(req.socket?.remoteAddress || "").trim() || "unknown";
}

function cleanup(now) {
  if (now < nextCleanupAt) {
    return;
  }

  for (const [key, entry] of entries.entries()) {
    if (entry.resetAt <= now) {
      entries.delete(key);
    }
  }

  nextCleanupAt = now + DEFAULT_CLEANUP_INTERVAL_MS;
}

function consumeRateLimit(key, limit, windowMs) {
  const now = Date.now();
  cleanup(now);

  const normalizedLimit = Math.max(1, Number(limit) || 1);
  const normalizedWindowMs = Math.max(1000, Number(windowMs) || 1000);
  const current = entries.get(key);

  if (!current || current.resetAt <= now) {
    const nextEntry = {
      count: 1,
      resetAt: now + normalizedWindowMs
    };
    entries.set(key, nextEntry);
    return {
      allowed: true,
      remaining: Math.max(0, normalizedLimit - nextEntry.count),
      retryAfterSeconds: Math.ceil(normalizedWindowMs / 1000)
    };
  }

  current.count += 1;
  entries.set(key, current);

  return {
    allowed: current.count <= normalizedLimit,
    remaining: Math.max(0, normalizedLimit - current.count),
    retryAfterSeconds: Math.max(1, Math.ceil((current.resetAt - now) / 1000))
  };
}

function enforceRateLimit(req, res, logger, options = {}) {
  const scope = String(options.scope || "default");
  const ip = getClientIp(req);
  const limit = Math.max(1, Number(options.limit) || 60);
  const windowMs = Math.max(1000, Number(options.windowMs) || 60 * 1000);
  const result = consumeRateLimit(`${scope}:${ip}`, limit, windowMs);

  res.setHeader("X-RateLimit-Limit", String(limit));
  res.setHeader("X-RateLimit-Remaining", String(result.remaining));

  if (result.allowed) {
    return true;
  }

  res.setHeader("Retry-After", String(result.retryAfterSeconds));
  logger?.warn?.("Rate limit exceeded", {
    scope,
    clientIp: ip,
    limit,
    windowMs,
    retryAfterSeconds: result.retryAfterSeconds
  });
  res.status(429).json({
    error: "Muitas tentativas em pouco tempo. Aguarde um instante e tente novamente."
  });
  return false;
}

module.exports = {
  enforceRateLimit,
  getClientIp
};
