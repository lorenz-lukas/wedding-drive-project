const {
  applyOriginHeaders,
  parseAllowedOrigins,
  resolveDriveFileId,
  runDriveOperation
} = require("../lib/_drive");
const { requireAuth } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");
const { readMediaToken } = require("../lib/media-token");
const { enforceRateLimit } = require("../lib/rate-limit");

function getTokenFromRequest(req) {
  if (req.query && req.query.token) {
    return String(req.query.token);
  }

  if (req.body && typeof req.body === "object" && req.body.token) {
    return String(req.body.token);
  }

  if (typeof req.body === "string") {
    try {
      const parsedBody = req.body ? JSON.parse(req.body) : {};
      return String(parsedBody.token || "");
    } catch {
      return "";
    }
  }

  return "";
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "challenge-submission-media");

  if (req.method === "POST") {
    try {
      req.body = await readJsonBody(req);
    } catch {
      return res.status(400).json({ error: "Corpo JSON invalido." });
    }
  }

  if (req.method !== "GET" && req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  applyOriginHeaders(req, res, allowedOrigins);

  if (!enforceRateLimit(req, res, logger, { scope: "challenge-submission-media", limit: 60, windowMs: 60 * 1000 })) {
    return;
  }

  if (!requireAuth(req, res)) {
    return;
  }

  try {
    const tokenPayload = readMediaToken(getTokenFromRequest(req), "challenge-submission-media");
    const fileId = resolveDriveFileId(tokenPayload?.fileId);
    if (!fileId) {
      return res.status(400).json({ error: "Token de midia invalido ou expirado." });
    }

    const result = await runDriveOperation(
      (drive) =>
        drive.files.get(
          {
            fileId,
            alt: "media",
            supportsAllDrives: true
          },
          {
            responseType: "stream"
          }
        ),
      { operationName: "challenge-submission-media-stream" }
    );

    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Content-Type", result.headers["content-type"] || "application/octet-stream");
    result.data.pipe(res);
  } catch (error) {
    logger.error("Challenge submission media loading failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });
    return res.status(500).json({
      error: "Falha ao carregar imagem do desafio.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};
