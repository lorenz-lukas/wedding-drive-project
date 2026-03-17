const { createSessionToken, validateCredentials } = require("./auth");
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
  const logger = createRequestLogger(req, "login");
  logger.info("Login request received");

  if (req.method !== "POST") {
    logger.warn("Login rejected due to invalid method");
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  try {
    const payload = await readJsonBody(req);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");
    logger.info("Login payload parsed", { username, passwordProvided: Boolean(password) });

    if (!validateCredentials(username, password)) {
      logger.warn("Login rejected because credentials are invalid", { username });
      return res.status(401).json({ error: "Usuario ou senha invalidos." });
    }

    const token = createSessionToken(username);
    logger.info("Login completed successfully", { username });

    return res.status(200).json({
      ok: true,
      token,
      username
    });
  } catch (error) {
    logger.error("Login failed", { errorMessage: error?.message });
    return res.status(400).json({ error: "Falha ao processar login." });
  }
};
