const { createSessionToken, hasConfiguredTokenSecret, validateCredentials } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");
const { enforceRateLimit } = require("../lib/rate-limit");

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
  const logger = createRequestLogger(req, "login");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  if (!enforceRateLimit(req, res, logger, { scope: "login", limit: 10, windowMs: 60 * 1000 })) {
    return;
  }

  try {
    if (!hasConfiguredTokenSecret()) {
      logger.error("Login unavailable because AUTH_TOKEN_SECRET is missing");
      return res.status(503).json({ error: "Autenticacao indisponivel." });
    }

    const payload = await readJsonBody(req);
    const username = String(payload.username || "").trim();
    const password = String(payload.password || "");

    if (!validateCredentials(username, password)) {
      logger.warn("Login rejected because credentials are invalid", { username });
      return res.status(401).json({ error: "Usuario ou senha invalidos." });
    }

    const token = createSessionToken(username);

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
