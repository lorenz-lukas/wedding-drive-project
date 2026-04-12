const fs = require("node:fs");
const { formidable } = require("formidable");
const { createRequestLogger } = require("../lib/_logger");
const {
  applyOriginHeaders,
  isOriginAllowed,
  parseAllowedOrigins
} = require("../lib/_drive");

const DEFAULT_MAX_FILES = 10;
const DEFAULT_MAX_FILE_SIZE_MB = 100;

module.exports.config = {
  api: {
    bodyParser: false
  }
};

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
      } catch {}
    })
  );
}

module.exports = async (req, res) => {
  let uploadedFiles = [];
  const logger = createRequestLogger(req, "upload-debug");

  logger.info("Upload debug request received");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Upload debug rejected due to unauthorized origin", {
      allowedOriginsCount: allowedOrigins.length
    });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  try {
    const maxFiles = Number(process.env.UPLOAD_MAX_FILES || DEFAULT_MAX_FILES);
    const maxFileSizeBytes =
      Number(process.env.UPLOAD_MAX_SIZE_MB || DEFAULT_MAX_FILE_SIZE_MB) * 1024 * 1024;

    const { fields, files } = await parseForm(req, maxFiles, maxFileSizeBytes);
    uploadedFiles = ensureFilesArray(files.photos);

    logger.info("Upload debug form parsed", {
      uploadedFilesCount: uploadedFiles.length,
      fieldNames: Object.keys(fields || {})
    });

    return res.status(200).json({
      ok: true,
      fileCount: uploadedFiles.length,
      files: uploadedFiles.map((file) => ({
        originalFilename: file.originalFilename || "",
        mimetype: file.mimetype || "",
        size: Number(file.size) || 0
      }))
    });
  } catch (error) {
    logger.error("Upload debug failed", {
      errorMessage: error && error.message ? error.message : "",
      errorCode: error && error.code ? error.code : ""
    });

    return res.status(500).json({
      error: "Falha no upload de diagnostico.",
      details: error && error.message ? error.message : undefined
    });
  } finally {
    await cleanupUploadedFiles(uploadedFiles);
  }
};
