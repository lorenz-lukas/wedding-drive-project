const {
  applyOriginHeaders,
  isGuestOnList,
  isOriginAllowed,
  parseAllowedOrigins,
  sanitizeGuestName
} = require("./_drive");
const { createRequestLogger } = require("./_logger");

async function readJsonBody(req) {
  const chunks = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const rawBody = Buffer.concat(chunks).toString("utf8");
  return rawBody ? JSON.parse(rawBody) : {};
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "validate-guest");
  logger.info("Guest validation request received");

  if (req.method !== "POST") {
    logger.warn("Guest validation rejected due to invalid method");
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Guest validation rejected due to unauthorized origin", {
      allowedOriginsCount: allowedOrigins.length
    });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  try {
    const payload = await readJsonBody(req);
    const guestName = sanitizeGuestName(payload.guestName || "");
    logger.info("Guest validation payload parsed", { guestName });

    if (!guestName || guestName === "convidado") {
      logger.warn("Guest validation rejected because guest name is missing or invalid");
      return res.status(400).json({ error: "Informe nome e sobrenome." });
    }

    const isAuthorized = await isGuestOnList(guestName);
    logger.info("Guest validation result computed", { guestName, isAuthorized });

    if (!isAuthorized) {
      logger.warn("Guest validation rejected because guest is not on the list", { guestName });
      return res.status(403).json({ error: "Nome nao encontrado na lista de convidados." });
    }

    logger.info("Guest validation completed successfully", { guestName });
    return res.status(200).json({ ok: true, guestName });
  } catch (error) {
    logger.error("Guest validation failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });
    if (
      error &&
      /lista de convidados|compartilhe o arquivo|GUEST_LIST_FILE_ID/i.test(String(error.message || ""))
    ) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(500).json({
      error: "Falha ao validar convidado.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};
