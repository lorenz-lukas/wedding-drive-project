const { google } = require("googleapis");
const { createLogger } = require("./_logger");

const GUEST_LIST_CACHE_TTL_MS = 5 * 60 * 1000;
const logger = createLogger("drive");

let guestListCache = {
  expiresAt: 0,
  normalizedGuests: new Set()
};
const guestFolderCache = new Map();

function resolveDriveFileId(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }

  const idFromPathMatch = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (idFromPathMatch) {
    return idFromPathMatch[1];
  }

  const idQueryMatch = value.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  if (idQueryMatch) {
    return idQueryMatch[1];
  }

  return value;
}

function parseAllowedOrigins() {
  const raw = process.env.ALLOWED_ORIGINS || "";
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isDevelopment() {
  return process.env.NODE_ENV !== "production";
}

function isLocalOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

function isOriginAllowed(req, allowedOrigins) {
  if (allowedOrigins.length === 0) {
    return true;
  }

  const origin = req.headers.origin;
  if (!origin) {
    return req.method === "GET" || req.method === "HEAD";
  }

  if (isDevelopment() && isLocalOrigin(origin)) {
    return true;
  }

  return allowedOrigins.includes(origin);
}

function applyOriginHeaders(req, res, allowedOrigins) {
  if (allowedOrigins.length === 0 && !isDevelopment()) {
    return;
  }

  const origin = req.headers.origin;
  if (origin && (allowedOrigins.includes(origin) || (isDevelopment() && isLocalOrigin(origin)))) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
}

function decodePrivateKey(keyBase64) {
  const decoded = Buffer.from(keyBase64, "base64").toString("utf8");
  return decoded.replace(/\\n/g, "\n");
}

function getDriveAuthMode() {
  const forcedMode = String(process.env.GOOGLE_AUTH_MODE || "")
    .trim()
    .toLowerCase();

  if (forcedMode === "oauth" || forcedMode === "service_account") {
    return forcedMode;
  }

  const hasOauthConfig = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );

  return hasOauthConfig ? "oauth" : "service_account";
}

function normalizeGuestName(input) {
  return String(input || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function sanitizeGuestName(input) {
  const safe = String(input || "convidado")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9-_ ]/g, "")
    .replace(/\s+/g, " ")
    .trim();

  return safe || "convidado";
}

function formatGuestFolderName(input) {
  return sanitizeGuestName(input)
    .split(/\s+/)
    .filter(Boolean)
    .join("_")
    .toUpperCase();
}

function validateRequiredEnv() {
  const authMode = getDriveAuthMode();
  const required = ["GOOGLE_DRIVE_FOLDER_ID", "GUEST_LIST_FILE_ID"];

  if (authMode === "oauth") {
    required.push(
      "GOOGLE_OAUTH_CLIENT_ID",
      "GOOGLE_OAUTH_CLIENT_SECRET",
      "GOOGLE_OAUTH_REFRESH_TOKEN"
    );
  } else {
    required.push("GOOGLE_CLIENT_EMAIL", "GOOGLE_PRIVATE_KEY_b64");
  }

  const missing = required.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    logger.error("Required Drive environment variables are missing", {
      authMode,
      missing
    });
    throw new Error(`Variaveis obrigatorias ausentes: ${missing.join(", ")}`);
  }

  const guestListFileId = resolveDriveFileId(process.env.GUEST_LIST_FILE_ID);
  if (!guestListFileId) {
    logger.error("Guest list file id is invalid after resolution");
    throw new Error("GUEST_LIST_FILE_ID invalido.");
  }
}

function createAuthClient() {
  validateRequiredEnv();
  const authMode = getDriveAuthMode();

  if (authMode === "oauth") {
    logger.info("Creating Google auth client", {
      authMode,
      oauthClientIdConfigured: Boolean(process.env.GOOGLE_OAUTH_CLIENT_ID)
    });

    const oauthClient = new google.auth.OAuth2(
      process.env.GOOGLE_OAUTH_CLIENT_ID,
      process.env.GOOGLE_OAUTH_CLIENT_SECRET
    );
    oauthClient.setCredentials({
      refresh_token: process.env.GOOGLE_OAUTH_REFRESH_TOKEN
    });
    return oauthClient;
  }

  logger.info("Creating Google auth client", {
    authMode,
    clientEmailConfigured: Boolean(process.env.GOOGLE_CLIENT_EMAIL)
  });

  return new google.auth.JWT({
    email: process.env.GOOGLE_CLIENT_EMAIL,
    key: decodePrivateKey(process.env.GOOGLE_PRIVATE_KEY_b64),
    scopes: ["https://www.googleapis.com/auth/drive"]
  });
}

function createDriveClient() {
  return google.drive({ version: "v3", auth: createAuthClient() });
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

function isGoogleWorkspaceFile(mimeType) {
  return String(mimeType || "").startsWith("application/vnd.google-apps.");
}

function isFileNotDownloadableError(error) {
  const reasonFromDetails = error?.errors?.[0]?.reason;
  const reasonFromResponse = error?.response?.data?.error?.errors?.[0]?.reason;
  return reasonFromDetails === "fileNotDownloadable" || reasonFromResponse === "fileNotDownloadable";
}

async function getGuestListFileMetadata(drive, fileId) {
  const metadata = await drive.files.get({
    fileId,
    supportsAllDrives: true,
    fields: "id,name,mimeType"
  });

  return metadata.data;
}

async function downloadGuestListContentAsText(drive, fileId) {
  const metadata = await getGuestListFileMetadata(drive, fileId);
  logger.info("Downloading guest list content", {
    fileId,
    mimeType: metadata.mimeType,
    name: metadata.name
  });

  if (isGoogleWorkspaceFile(metadata.mimeType)) {
    const exportMimeType = metadata.mimeType === "application/vnd.google-apps.spreadsheet"
      ? "text/csv"
      : "text/plain";

    const exported = await drive.files.export(
      {
        fileId,
        mimeType: exportMimeType
      },
      {
        responseType: "stream"
      }
    );

    return streamToString(exported.data);
  }

  const downloaded = await drive.files.get(
    {
      fileId,
      alt: "media",
      supportsAllDrives: true
    },
    {
      responseType: "stream"
    }
  );

  return streamToString(downloaded.data);
}

async function fetchGuestListFromDrive() {
  const drive = createDriveClient();
  const guestListFileId = resolveDriveFileId(process.env.GUEST_LIST_FILE_ID);
  let content;

  logger.info("Fetching guest list from Drive", { guestListFileId });

  try {
    content = await downloadGuestListContentAsText(drive, guestListFileId);
  } catch (error) {
    if (error && isFileNotDownloadableError(error)) {
      logger.warn("Guest list is not directly downloadable, attempting export fallback", {
        guestListFileId
      });
      try {
        const exported = await drive.files.export(
          {
            fileId: guestListFileId,
            mimeType: "text/plain"
          },
          {
            responseType: "stream"
          }
        );
        content = await streamToString(exported.data);
        logger.info("Guest list export fallback succeeded", { guestListFileId });
      } catch (exportError) {
        logger.error("Guest list export fallback failed", {
          guestListFileId,
          errorMessage: exportError?.message,
          errorCode: exportError?.code
        });
        throw exportError;
      }
    }

    if (content) {
      // content obtido por fallback de export.
    } else if (error && error.code === 404) {
      logger.error("Guest list file not found on Drive", { guestListFileId });
      throw new Error(
        "Arquivo da lista de convidados nao encontrado no Google Drive. Verifique GUEST_LIST_FILE_ID e o compartilhamento com a Service Account."
      );
    } else if (error && error.code === 403) {
      logger.error("Service account has no permission to access guest list file", { guestListFileId });
      throw new Error(
        "Sem permissao para acessar o arquivo da lista de convidados. Compartilhe o arquivo com a Service Account como leitor ou editor."
      );
    } else {
      logger.error("Unexpected error while fetching guest list", {
        guestListFileId,
        errorMessage: error?.message,
        errorCode: error?.code
      });
      throw error;
    }
  }

  const normalizedGuests = new Set(
    content
      .split(/\r?\n/)
      .map((line) => normalizeGuestName(line))
      .filter(Boolean)
  );

  guestListCache = {
    expiresAt: Date.now() + GUEST_LIST_CACHE_TTL_MS,
    normalizedGuests
  };

  logger.info("Guest list loaded into cache", {
    guestCount: normalizedGuests.size,
    expiresAt: guestListCache.expiresAt
  });

  return normalizedGuests;
}

async function getGuestList() {
  if (guestListCache.expiresAt > Date.now() && guestListCache.normalizedGuests.size > 0) {
    logger.info("Guest list served from cache", { guestCount: guestListCache.normalizedGuests.size });
    return guestListCache.normalizedGuests;
  }

  return fetchGuestListFromDrive();
}

async function isGuestOnList(guestName) {
  const normalizedGuestName = normalizeGuestName(guestName);
  if (!normalizedGuestName) {
    logger.warn("Guest list check received empty normalized name");
    return false;
  }

  const guestList = await getGuestList();
  const found = guestList.has(normalizedGuestName);
  logger.info("Guest list membership checked", { guestName: normalizedGuestName, found });
  return found;
}

async function ensureGuestFolder(guestName) {
  const folderName = formatGuestFolderName(guestName);
  if (!folderName) {
    logger.error("Guest folder name is invalid", { guestName });
    throw new Error("Nome de pasta do convidado invalido.");
  }

  if (guestFolderCache.has(folderName)) {
    logger.info("Guest folder served from cache", {
      guestName,
      folderName,
      folderId: guestFolderCache.get(folderName)
    });
    return {
      id: guestFolderCache.get(folderName),
      name: folderName,
      created: false
    };
  }

  const drive = createDriveClient();
  const parentId = process.env.GOOGLE_DRIVE_FOLDER_ID;
  const escapedFolderName = folderName.replace(/'/g, "\\'");

  logger.info("Resolving guest folder on Drive", { guestName, folderName, parentId });

  const lookup = await drive.files.list({
    q: [
      `mimeType = 'application/vnd.google-apps.folder'`,
      `name = '${escapedFolderName}'`,
      `'${parentId}' in parents`,
      `trashed = false`
    ].join(" and "),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: "files(id,name)",
    pageSize: 1
  });

  const existingFolder = lookup.data.files && lookup.data.files[0];
  if (existingFolder) {
    guestFolderCache.set(folderName, existingFolder.id);
    logger.info("Existing guest folder found", {
      guestName,
      folderName,
      folderId: existingFolder.id
    });
    return {
      ...existingFolder,
      created: false
    };
  }

  const createdFolder = await drive.files.create({
    supportsAllDrives: true,
    requestBody: {
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId]
    },
    fields: "id,name"
  });

  guestFolderCache.set(folderName, createdFolder.data.id);
  logger.info("Guest folder created", {
    guestName,
    folderName,
    folderId: createdFolder.data.id
  });
  return {
    ...createdFolder.data,
    created: true
  };
}

module.exports = {
  applyOriginHeaders,
  createAuthClient,
  createDriveClient,
  ensureGuestFolder,
  formatGuestFolderName,
  getDriveAuthMode,
  isGuestOnList,
  isOriginAllowed,
  parseAllowedOrigins,
  resolveDriveFileId,
  sanitizeGuestName,
  validateRequiredEnv
};
