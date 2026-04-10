const {
  applyOriginHeaders,
  ensureNamedFolder,
  isOriginAllowed,
  parseAllowedOrigins,
  runDriveOperation
} = require("../lib/_drive");
const challengeHandler = require("./challenge");
const { createRequestLogger } = require("../lib/_logger");

const CHALLENGE_FOLDER_NAME = "desafios";

function extractSubmitterName(fileName, challengeNumber) {
  const marker = `_${challengeNumber}_desafio_`;
  const index = String(fileName || "").indexOf(marker);
  if (index <= 0) {
    return "";
  }
  return fileName.slice(0, index).replace(/_/g, " ");
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "challenge-submissions");
  logger.info("Challenge submissions request received");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Challenge submissions rejected due to unauthorized origin", {
      allowedOriginsCount: allowedOrigins.length
    });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  try {
    const challenge = await challengeHandler.readState();
    if (challenge.roundClosedAt) {
      return res.status(200).json({ ok: true, challengeNumber: challenge.challengeNumber, photos: [] });
    }

    const challengeNumber = Number(challenge.challengeNumber || 1);
    const challengeFolder = await ensureNamedFolder(
      process.env.GOOGLE_DRIVE_FOLDER_ID,
      challenge.challengeFolderName || CHALLENGE_FOLDER_NAME
    );
    const marker = `_${challengeNumber}_desafio_`;
    const photos = await runDriveOperation(async (drive) => {
      let pageToken;
      const collected = [];

      do {
        const response = await drive.files.list({
          q: [`'${challengeFolder.id}' in parents`, `trashed = false`].join(" and "),
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields: "nextPageToken, files(id,name,mimeType,createdTime)",
          pageToken,
          pageSize: 200,
          orderBy: "createdTime desc"
        });

        for (const file of response.data.files || []) {
          if (!String(file.mimeType || "").startsWith("image/")) {
            continue;
          }
          if (!String(file.name || "").includes(marker)) {
            continue;
          }

          collected.push({
            id: file.id,
            name: file.name,
            guestName: extractSubmitterName(file.name, challengeNumber),
            src: `/api/challenge-submission-media?fileId=${encodeURIComponent(file.id)}`
          });
        }

        pageToken = response.data.nextPageToken;
      } while (pageToken);

      return collected;
    }, { operationName: "challenge-submissions-feed" });

    return res.status(200).json({
      ok: true,
      challengeNumber,
      photos
    });
  } catch (error) {
    logger.error("Challenge submissions loading failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });
    return res.status(500).json({
      error: "Falha ao carregar imagens do desafio.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};
