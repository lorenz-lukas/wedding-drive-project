const fs = require("node:fs");
const path = require("node:path");
const { formidable } = require("formidable");
const { google } = require("googleapis");
const { createRequestLogger } = require("../lib/_logger");
const {
  applyOriginHeaders,
  createAuthClient,
  ensureGuestFolder,
  isGuestOnList,
  isOriginAllowed,
  parseAllowedOrigins,
  sanitizeGuestName,
  validateRequiredEnv
} = require("../lib/_drive");

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_SIZE_MB = 15;
const ACCEPTED_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "video/mp4",
  "video/quicktime"
]);

module.exports.config = {
  api: {
    bodyParser: false
  }
};

function getExtensionFromFile(file) {
  const extFromName = path.extname(file.originalFilename || "").toLowerCase();
  if (extFromName) {
    return extFromName;
  }

  if (file.mimetype === "image/png") return ".png";
  if (file.mimetype === "image/webp") return ".webp";
  if (file.mimetype === "image/heic") return ".heic";
  if (file.mimetype === "image/heif") return ".heif";
  if (file.mimetype === "video/mp4") return ".mp4";
  if (file.mimetype === "video/quicktime") return ".mov";
  return ".jpg";
}

function parseForm(req, maxFiles, maxFileSizeBytes) {
  const form = formidable({
    multiples: true,
    maxFiles,
    maxFileSize: maxFileSizeBytes,
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

function ensureFilesArray(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return [files];
}

async function cleanupUploadedFiles(files) {
  await Promise.all(
    files.map(async (file) => {
      if (!file || !file.filepath) {
        return;
      }

      try {
        await fs.promises.unlink(file.filepath);
      } catch {
        // Ignora falhas de limpeza de arquivo temporario.
      }
    })
  );
}

function getUploadErrorDetails(error) {
  return (
    error?.response?.data?.error?.message ||
    error?.errors?.[0]?.message ||
    error?.message ||
    undefined
  );
}

function isServiceAccountStorageQuotaError(error) {
  const details = getUploadErrorDetails(error) || "";
  return details.includes("Service Accounts do not have storage quota");
}

async function uploadToDrive(authClient, folderId, file, guestName) {
  const drive = google.drive({ version: "v3", auth: authClient });
  const extension = getExtensionFromFile(file);
  const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
  const baseName = sanitizeGuestName(guestName);
  const targetFileName = `${timestamp}_${baseName}${extension}`;

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

module.exports = async (req, res) => {
  let uploadedFiles = [];
  const logger = createRequestLogger(req, "upload");

  logger.info("Upload request received");

  if (req.method !== "POST") {
    logger.warn("Upload rejected due to invalid method");
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Upload rejected due to unauthorized origin", { allowedOriginsCount: allowedOrigins.length });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  try {
    validateRequiredEnv();
    logger.info("Upload environment validated");

    const maxFiles = Number(process.env.UPLOAD_MAX_FILES || DEFAULT_MAX_FILES);
    const maxFileSizeBytes =
      Number(process.env.UPLOAD_MAX_SIZE_MB || DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;

    const { fields, files } = await parseForm(req, maxFiles, maxFileSizeBytes);
    uploadedFiles = ensureFilesArray(files.photos);
    logger.info("Upload form parsed", {
      uploadedFilesCount: uploadedFiles.length,
      fieldNames: Object.keys(fields || {})
    });

    if (uploadedFiles.length === 0) {
      logger.warn("Upload rejected because no files were sent");
      return res.status(400).json({ error: "Nenhuma foto foi enviada." });
    }

    for (const file of uploadedFiles) {
      if (!ACCEPTED_MIME_TYPES.has(file.mimetype)) {
        logger.warn("Upload rejected due to unsupported mime type", {
          mimeType: file.mimetype,
          originalFilename: file.originalFilename
        });
        return res.status(400).json({ error: "Tipo de arquivo nao permitido." });
      }
    }

    const guestNameRaw = Array.isArray(fields.guestName) ? fields.guestName[0] : fields.guestName;
    const guestName = sanitizeGuestName(guestNameRaw || "");
    logger.info("Upload guest identified", { guestName, rawGuestNamePresent: Boolean(guestNameRaw) });

    if (!guestName || guestName === "convidado") {
      logger.warn("Upload rejected because guest name is missing or invalid");
      return res.status(400).json({ error: "Informe nome e sobrenome do convidado." });
    }

    const isAuthorized = await isGuestOnList(guestName);
    if (!isAuthorized) {
      logger.warn("Upload rejected because guest is not on the list", { guestName });
      return res.status(403).json({ error: "Nome nao encontrado na lista de convidados." });
    }

    const authClient = createAuthClient();
    logger.info("Upload auth client created", { guestName });
    const guestFolder = await ensureGuestFolder(guestName);
    logger.info("Guest folder resolved", {
      guestName,
      folderId: guestFolder.id,
      folderName: guestFolder.name,
      folderCreated: guestFolder.created
    });

    const uploaded = [];

    for (const file of uploadedFiles) {
      logger.info("Uploading file to Drive", {
        guestName,
        originalFilename: file.originalFilename,
        mimeType: file.mimetype,
        size: file.size,
        folderId: guestFolder.id
      });
      const data = await uploadToDrive(
        authClient,
        guestFolder.id,
        file,
        guestName
      );
      uploaded.push(data);
      logger.info("File uploaded to Drive", {
        guestName,
        driveFileId: data.id,
        driveFileName: data.name
      });
    }

    logger.info("Upload request completed successfully", {
      guestName,
      guestFolderId: guestFolder.id,
      guestFolderCreated: guestFolder.created,
      uploadedCount: uploaded.length
    });

    return res.status(200).json({
      ok: true,
      uploadedCount: uploaded.length
    });
  } catch (error) {
    if (error && error.code === 1009) {
      logger.warn("Upload rejected because a file exceeds the size limit", {
        errorCode: error.code,
        errorMessage: error.message
      });
      return res.status(400).json({ error: "Arquivo excede o tamanho maximo permitido." });
    }

    if (isServiceAccountStorageQuotaError(error)) {
      logger.error("Upload failed because service account has no storage quota", {
        details: getUploadErrorDetails(error)
      });
      return res.status(500).json({
        error: "A conta de servico nao consegue enviar arquivos para uma pasta em Meu Drive. Mova a pasta do casamento para um Shared Drive e compartilhe esse drive com a Service Account.",
        details: process.env.NODE_ENV === "development" ? getUploadErrorDetails(error) : undefined
      });
    }

    const details = getUploadErrorDetails(error);
    logger.error("Upload failed with unexpected error", {
      details,
      errorCode: error?.code,
      errorMessage: error?.message
    });

    return res.status(500).json({
      error: "Falha ao processar upload.",
      details: process.env.NODE_ENV === "development" ? details : undefined
    });
  } finally {
    if (uploadedFiles.length > 0) {
      logger.info("Cleaning up temporary uploaded files", { uploadedFilesCount: uploadedFiles.length });
      await cleanupUploadedFiles(uploadedFiles);
    }
  }
};
