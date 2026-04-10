const {
  runDriveOperation,
  parseAllowedOrigins,
  isOriginAllowed,
  applyOriginHeaders,
  resolveDriveFileId
} = require("../lib/_drive");
const { requireAuth } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");

const DEFAULT_MAX_GALLERY_ITEMS = 500;
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
      fields: "nextPageToken, files(id,name,mimeType,createdTime)",
      pageToken,
      pageSize: 200,
      orderBy: "createdTime desc"
    });

    files.push(...(response.data.files || []));
    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return files;
}

async function collectGalleryPhotos(rootFolderId) {
  const rawMaxItems = Number(process.env.GALLERY_MAX_ITEMS || DEFAULT_MAX_GALLERY_ITEMS);
  const maxItems = Number.isFinite(rawMaxItems) && rawMaxItems > 0 ? rawMaxItems : Number.POSITIVE_INFINITY;

  return runDriveOperation(async (drive) => {
    const queue = [rootFolderId];
    const visitedFolders = new Set();
    const photos = [];

    while (queue.length > 0 && photos.length < maxItems) {
      const folderId = queue.shift();

      if (!folderId || visitedFolders.has(folderId)) {
        continue;
      }

      visitedFolders.add(folderId);

      const children = await listFolderChildren(drive, folderId);

      for (const item of children) {
        if (item.mimeType === FOLDER_MIME) {
          queue.push(item.id);
          continue;
        }

        if (!IMAGE_MIME_TYPES.has(item.mimeType)) {
          continue;
        }

        photos.push({
          id: item.id,
          name: item.name,
          createdTime: item.createdTime
        });

        if (photos.length >= maxItems) {
          break;
        }
      }
    }

    return photos;
  }, { operationName: "collect-gallery-photos" });
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "gallery");
  logger.info("Gallery request received");

  if (req.method !== "GET") {
    logger.warn("Gallery rejected due to invalid method");
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Gallery rejected due to unauthorized origin", { allowedOriginsCount: allowedOrigins.length });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  if (!requireAuth(req, res)) {
    logger.warn("Gallery rejected because authentication failed");
    return;
  }

  try {
    const rootFolderId = resolveDriveFileId(process.env.GOOGLE_DRIVE_FOLDER_ID);
    logger.info("Collecting gallery photos", { rootFolderId });
    const photos = await collectGalleryPhotos(rootFolderId);

    logger.info("Gallery loaded successfully", { rootFolderId, photoCount: photos.length });

    return res.status(200).json({
      ok: true,
      count: photos.length,
      photos: photos.map((photo) => ({
        id: photo.id,
        src: `/api/gallery-media?fileId=${encodeURIComponent(photo.id)}`,
        alt: "Foto enviada pelos convidados",
        caption: ""
      }))
    });
  } catch (error) {
    logger.error("Gallery loading failed", {
      errorMessage: error?.message,
      errorCode: error?.code
    });
    return res.status(500).json({
      error: "Falha ao carregar galeria.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};
