const {
  applyOriginHeaders,
  parseAllowedOrigins,
  resolveDriveFileId,
  runDriveOperation
} = require("../lib/_drive");
const { requireAuth } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");
const { enforceRateLimit } = require("../lib/rate-limit");

function getFileIdFromRequest(req) {
  const parsedUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  return parsedUrl.searchParams.get("fileId") || "";
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "challenge-submission-media");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
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
    const fileId = resolveDriveFileId(getFileIdFromRequest(req));
    if (!fileId) {
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
      { operationName: "challenge-submission-media-stream" }
    );

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
