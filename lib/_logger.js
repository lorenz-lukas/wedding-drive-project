const { randomUUID } = require("node:crypto");

const SENSITIVE_KEY_PATTERN = /(authorization|password|secret|token|privatekey|key)$/i;

function truncateString(value) {
  if (typeof value !== "string") {
    return value;
  }

  if (value.length <= 180) {
    return value;
  }

  return `${value.slice(0, 177)}...`;
}

function sanitizeForLog(value, depth = 0) {
  if (depth > 3) {
    return "[MaxDepth]";
  }

  if (value === null || value === undefined) {
    return value;
  }

  if (typeof value === "string") {
    return truncateString(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForLog(item, depth + 1));
  }

  if (typeof value === "object") {
    const sanitized = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      sanitized[key] = SENSITIVE_KEY_PATTERN.test(key)
        ? "[REDACTED]"
        : sanitizeForLog(nestedValue, depth + 1);
    }

    return sanitized;
  }

  return value;
}

function writeLog(level, scope, message, metadata) {
  const payload = {
    timestamp: new Date().toISOString(),
    level,
    scope,
    message,
    ...(metadata ? { metadata: sanitizeForLog(metadata) } : {})
  };

  const line = JSON.stringify(payload);

  if (level === "error") {
    console.error(line);
    return;
  }

  console.log(line);
}

function createRequestLogger(req, scope) {
  const requestId = req.headers["x-request-id"] || randomUUID();
  const baseMetadata = {
    requestId,
    method: req.method,
    path: req.url,
    origin: req.headers.origin || null
  };

  return {
    requestId,
    info(message, metadata) {
      writeLog("info", scope, message, { ...baseMetadata, ...metadata });
    },
    warn(message, metadata) {
      writeLog("warn", scope, message, { ...baseMetadata, ...metadata });
    },
    error(message, metadata) {
      writeLog("error", scope, message, { ...baseMetadata, ...metadata });
    }
  };
}

function createLogger(scope) {
  return {
    info(message, metadata) {
      writeLog("info", scope, message, metadata);
    },
    warn(message, metadata) {
      writeLog("warn", scope, message, metadata);
    },
    error(message, metadata) {
      writeLog("error", scope, message, metadata);
    }
  };
}

module.exports = {
  createLogger,
  createRequestLogger,
  sanitizeForLog
};
