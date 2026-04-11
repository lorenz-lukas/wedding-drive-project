const {
  runDriveOperation,
  parseAllowedOrigins,
  isOriginAllowed,
  applyOriginHeaders,
  resolveDriveFileId
} = require("../lib/_drive");
const { requireAuth } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");
const { enforceRateLimit } = require("../lib/rate-limit");

function getFileIdFromRequest(req) {
  if (req.query && req.query.fileId) {
    return String(req.query.fileId);
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return parsedUrl.searchParams.get("fileId") || "";
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "gallery-media");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
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
    const fileId = resolveDriveFileId(getFileIdFromRequest(req));
    if (!fileId) {
      logger.warn("Gallery media rejected because fileId is missing");
      return res.status(400).json({ error: "fileId obrigatorio." });
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
