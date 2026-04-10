const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { formidable } = require("formidable");
const { google } = require("googleapis");
const { createRequestLogger } = require("../lib/_logger");
const {
  applyOriginHeaders,
  createAuthClient,
  ensureNamedFolder,
  isGuestOnList,
  isOriginAllowed,
  parseAllowedOrigins,
  sanitizeGuestName,
  validateRequiredEnv
} = require("../lib/_drive");
const challengeHandler = require("./challenge");

const MAX_FILE_SIZE_MB = 15;
const CHALLENGE_FOLDER_NAME = "desafios";
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif"
]);

const handler = async (req, res) => {
  let uploadedFile = null;
  const logger = createRequestLogger(req, "challenge-upload");
  logger.info("Challenge upload request received");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Challenge upload rejected due to unauthorized origin", {
      allowedOriginsCount: allowedOrigins.length
    });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  try {
    validateRequiredEnv();

    const { fields, files } = await parseForm(req);
    uploadedFile = Array.isArray(files.photo) ? files.photo[0] : files.photo;

    if (!uploadedFile) {
      return res.status(400).json({ error: "Envie uma imagem do desafio." });
    }

    if (!ACCEPTED_MIME_TYPES.has(uploadedFile.mimetype)) {
      return res.status(400).json({ error: "Tipo de arquivo nao permitido." });
    }

    const guestNameRaw = Array.isArray(fields.guestName) ? fields.guestName[0] : fields.guestName;
    const guestName = sanitizeGuestName(guestNameRaw || "");

    if (!guestName || guestName === "convidado") {
      return res.status(400).json({ error: "Informe seu nome para enviar a imagem." });
    }

    const isAuthorized = await isGuestOnList(guestName);
    if (!isAuthorized) {
      logger.warn("Challenge upload rejected because guest is not on the list", { guestName });
      return res.status(403).json({ error: "Nome nao encontrado na lista de convidados." });
    }

    const challenge = await challengeHandler.readState();
    const challengeFolder = await ensureNamedFolder(
      process.env.GOOGLE_DRIVE_FOLDER_ID,
      challenge.challengeFolderName || CHALLENGE_FOLDER_NAME
    );
    const authClient = createAuthClient();
    const uploaded = await uploadToDrive(authClient, challengeFolder.id, uploadedFile, guestName);

    logger.info("Challenge upload completed successfully", {
      guestName,
      folderId: challengeFolder.id,
      driveFileId: uploaded.id
    });

    return res.status(200).json({
      ok: true,
      file: uploaded,
      folder: challengeFolder
    });
  } catch (error) {
    logger.error("Challenge upload failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });
    return res.status(error?.code === "DUPLICATE_CHALLENGE_SUBMISSION" ? 409 : 500).json({
      error:
        error?.code === "DUPLICATE_CHALLENGE_SUBMISSION"
          ? error.message
          : "Falha ao enviar imagem do desafio.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  } finally {
    await cleanupUploadedFile(uploadedFile);
  }
};

handler.config = {
  api: {
    bodyParser: false
  }
};

function parseForm(req) {
  const form = formidable({
    multiples: false,
    maxFiles: 1,
    maxFileSize: MAX_FILE_SIZE_MB * 1024 * 1024,
    allowEmptyFiles: false
  });

  return new Promise((resolve, reject) => {
    form.parse(req, (err, fields, files) => {
      if (err) {
        reject(err);
        return;
      }
      resolve({ fields, files });
    });
  });
}

function getExtensionFromFile(file) {
  const extFromName = path.extname(file.originalFilename || "").toLowerCase();
  if (extFromName) {
    return extFromName;
  }

  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  if (file.mimetype === "image/heic") return ".heic";
  if (file.mimetype === "image/heif") return ".heif";
  return ".jpg";
}

async function cleanupUploadedFile(file) {
  if (!file?.filepath) {
    return;
  }

  try {
    await fs.promises.unlink(file.filepath);
  } catch {}
}

async function uploadToDrive(authClient, folderId, file, guestName) {
  const drive = google.drive({ version: "v3", auth: authClient });
  const extension = getExtensionFromFile(file);
  const challenge = await challengeHandler.readState();
  const challengeNumber = Number(challenge.challengeNumber || 1);
  const safeName = sanitizeGuestName(guestName).replace(/\s+/g, "_") || "convidado";
  const submissionMarker = `${safeName}_${challengeNumber}_desafio_`;

  const existing = await drive.files.list({
    q: [
      `'${folderId}' in parents`,
      `trashed = false`,
      `name contains '${submissionMarker.replace(/'/g, "\\'")}'`
    ].join(" and "),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: "files(id,name)",
    pageSize: 1
  });

  if (existing.data.files?.length) {
    const error = new Error("Voce ja enviou uma imagem neste desafio.");
    error.code = "DUPLICATE_CHALLENGE_SUBMISSION";
    throw error;
  }

  const targetFileName = `${safeName.toUpperCase()}_${challengeNumber}_desafio_${randomUUID()}${extension}`;

  const result = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: targetFileName,
      parents: [folderId]
    },
    media: {
      mimeType: file.mimetype || "application/octet-stream",
      body: fs.createReadStream(file.filepath)
    },
    fields: "id,name"
  });

  return result.data;
}

module.exports = handler;
