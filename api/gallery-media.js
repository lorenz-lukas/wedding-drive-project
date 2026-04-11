const {
  runDriveOperation,
  parseAllowedOrigins,
  isOriginAllowed,
  applyOriginHeaders,
  resolveDriveFileId
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
  const logger = createRequestLogger(req, "gallery-media");

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
  if (req.headers.origin && !isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Gallery media rejected due to unauthorized origin", { allowedOriginsCount: allowedOrigins.length });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  if (!enforceRateLimit(req, res, logger, { scope: "gallery-media", limit: 120, windowMs: 60 * 1000 })) {
    return;
  }

  if (!requireAuth(req, res)) {
    return;
  }

  try {
    const tokenPayload = readMediaToken(getTokenFromRequest(req), "gallery-media");
    const fileId = resolveDriveFileId(tokenPayload?.fileId);
    if (!fileId) {
      logger.warn("Gallery media rejected because token is invalid");
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
      { operationName: "gallery-media-stream" }
    );

    const mimeType = result.headers["content-type"] || "application/octet-stream";
    res.setHeader("Cache-Control", "private, no-store, max-age=0");
    res.setHeader("X-Robots-Tag", "noindex, nofollow, noarchive");
    res.setHeader("Content-Type", mimeType);
    result.data.pipe(res);
  } catch (error) {
    logger.error("Gallery media loading failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });
    return res.status(500).json({
      error: "Falha ao carregar imagem da galeria.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};
