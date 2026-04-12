const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_SIZE_MB = 15;
const VERCEL_SAFE_REQUEST_LIMIT_MB = 4;
const DEFAULT_SLIDE_INTERVAL_MS = 2000;
const DEFAULT_FIRST_SLIDE_DELAY_MS = 5000;
const { createRequestLogger } = require("../lib/_logger");

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "config");

  if (req.method !== "GET") {
    logger.warn("Config rejected due to invalid method");
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const configuredMaxFiles = Number(process.env.UPLOAD_MAX_FILES || DEFAULT_MAX_FILES);
  const configuredMaxSizeMb = Number(process.env.UPLOAD_MAX_SIZE_MB || DEFAULT_MAX_SIZE_MB);
  const requestBodyLimitMb = process.env.VERCEL ? VERCEL_SAFE_REQUEST_LIMIT_MB : null;
  const maxFiles = configuredMaxFiles;
  const maxSizeMb = requestBodyLimitMb
    ? Math.min(configuredMaxSizeMb, requestBodyLimitMb)
    : configuredMaxSizeMb;
  const slideIntervalMs = Number(process.env.SLIDE_INTERVAL_MS || DEFAULT_SLIDE_INTERVAL_MS);
  const firstSlideDelayMs = Number(
    process.env.FIRST_SLIDE_DELAY_MS || DEFAULT_FIRST_SLIDE_DELAY_MS
  );

  logger.info("Config served", {
    maxFiles,
    maxSizeMb,
    requestBodyLimitMb,
    slideIntervalMs,
    firstSlideDelayMs
  });

  return res.status(200).json({
    maxFiles,
    maxSizeMb,
    requestBodyLimitMb,
    slideIntervalMs,
    firstSlideDelayMs
  });
};
