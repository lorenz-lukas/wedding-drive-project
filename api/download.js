const archiver = require("archiver");
const {
  runDriveOperation,
  parseAllowedOrigins,
  isOriginAllowed,
  applyOriginHeaders,
  resolveDriveFileId
} = require("./_drive");
const { requireAuth } = require("./auth");
const { createRequestLogger } = require("./_logger");

const FOLDER_MIME = "application/vnd.google-apps.folder";
const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/heic",
  "image/heif",
  "image/gif"
]);

async function listFolderChildren(drive, folderId) {
  let pageToken;
  const files = [];

  do {
    const response = await drive.files.list({
      q: `'${folderId}' in parents and trashed = false`,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "nextPageToken, files(id,name,mimeType,parents)",
      pageToken,
      pageSize: 200
    });

    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

/**
 * Returns a flat list of { id, name, mimeType, folderPath } for all images
 * found recursively under rootFolderId.
 */
async function collectAllImages(drive, rootFolderId) {
  const queue = [{ id: rootFolderId, path: "" }];
  const visited = new Set();
  const images = [];

  while (queue.length > 0) {
    const { id: folderId, path: folderPath } = queue.shift();

    if (visited.has(folderId)) {
      continue;
    }
    visited.add(folderId);

    const children = await listFolderChildren(drive, folderId);

    for (const item of children) {
      if (item.mimeType === FOLDER_MIME) {
        queue.push({ id: item.id, path: folderPath ? `${folderPath}/${item.name}` : item.name });
        continue;
      }

      if (IMAGE_MIME_TYPES.has(item.mimeType)) {
        images.push({
          id: item.id,
          name: item.name,
          folderPath
        });
      }
    }
  }

  return images;
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "download");
  logger.info("Download request received");

  if (req.method !== "GET") {
    logger.warn("Download rejected due to invalid method");
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Download rejected due to unauthorized origin");
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  if (!requireAuth(req, res)) {
    logger.warn("Download rejected because authentication failed");
    return;
  }

  try {
    const rootFolderId = resolveDriveFileId(process.env.GOOGLE_DRIVE_FOLDER_ID);
    logger.info("Collecting images for download", { rootFolderId });

    const images = await runDriveOperation(
      (drive) => collectAllImages(drive, rootFolderId),
      { operationName: "download-collect-images" }
    );
    logger.info("Images collected", { count: images.length });

    res.setHeader("Content-Type", "application/zip");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="casamento-dougrax-ju.zip"'
    );

    const archive = archiver("zip", { zlib: { level: 5 } });

    archive.on("error", (err) => {
      logger.error("Archiver error", { errorMessage: err.message });
      if (!res.headersSent) {
        res.status(500).json({ error: "Falha ao criar arquivo ZIP." });
      } else {
        res.end();
      }
    });

    archive.pipe(res);

    for (const image of images) {
      const driveRes = await runDriveOperation(
        (drive) =>
          drive.files.get(
            { fileId: image.id, alt: "media", supportsAllDrives: true },
            { responseType: "stream" }
          ),
        { operationName: "download-image-stream" }
      );

      const entryName = image.folderPath
        ? `${image.folderPath}/${image.name}`
        : image.name;

      archive.append(driveRes.data, { name: entryName });
    }

    await archive.finalize();
    logger.info("Download ZIP finalized", { fileCount: images.length });
  } catch (error) {
    logger.error("Download failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });

    if (!res.headersSent) {
      return res.status(500).json({
        error: "Falha ao gerar download.",
        details: process.env.NODE_ENV === "development" ? error.message : undefined
      });
    }
  }
};
