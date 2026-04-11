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

function allowsAnyOrigin(allowedOrigins) {
  return allowedOrigins.includes("*");
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

  if (allowsAnyOrigin(allowedOrigins)) {
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
  if (allowsAnyOrigin(allowedOrigins)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
    return;
  }

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

  if (forcedMode === "oauth" && !hasOauthConfig() && hasServiceAccountConfig()) {
    logger.warn("OAuth mode requested without complete OAuth credentials; falling back to service_account");
    return "service_account";
  }

  if (forcedMode === "oauth" || forcedMode === "service_account") {
    return forcedMode;
  }

  return hasOauthConfig() ? "oauth" : "service_account";
}

function hasOauthConfig() {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
}

function hasServiceAccountConfig() {
  return Boolean(process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY_b64);
}

function isInvalidGrantError(error) {
  const details = String(
    error?.response?.data?.error ||
      error?.response?.data?.error_description ||
      error?.message ||
      ""
  ).toLowerCase();

  return details.includes("invalid_grant");
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

function validateRequiredEnv(authModeOverride) {
  const authMode = authModeOverride || getDriveAuthMode();
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

function createAuthClient(authModeOverride) {
  const authMode = authModeOverride || getDriveAuthMode();
  validateRequiredEnv(authMode);

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

function createDriveClient(authModeOverride) {
  return google.drive({ version: "v3", auth: createAuthClient(authModeOverride) });
}

async function runDriveOperation(operation, options = {}) {
  const {
    fallbackToServiceAccountOnInvalidGrant = true,
    operationName = "drive-operation"
  } = options;

  const primaryAuthMode = getDriveAuthMode();
  logger.info("Starting Drive operation", {
    operationName,
    primaryAuthMode,
    fallbackToServiceAccountOnInvalidGrant
  });

  try {
    const result = await operation(createDriveClient(primaryAuthMode), primaryAuthMode);
    logger.info("Drive operation completed successfully", {
      operationName,
      authMode: primaryAuthMode
    });
    return result;
  } catch (error) {
    logger.error("Drive operation failed", {
      operationName,
      authMode: primaryAuthMode,
      errorMessage: error?.message,
      errorCode: error?.code,
      errorStatus: error?.response?.status,
      errorData: error?.response?.data
    });
    if (
      fallbackToServiceAccountOnInvalidGrant &&
      primaryAuthMode === "oauth" &&
      hasServiceAccountConfig() &&
      isInvalidGrantError(error)
    ) {
      logger.warn("Drive operation hit invalid_grant; retrying with service_account", {
        operationName
      });
      const fallbackResult = await operation(createDriveClient("service_account"), "service_account");
      logger.info("Drive operation completed successfully after fallback", {
        operationName,
        authMode: "service_account"
      });
      return fallbackResult;
    }

    throw error;
  }
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
  const guestListFileId = resolveDriveFileId(process.env.GUEST_LIST_FILE_ID);
  let content;

  logger.info("Fetching guest list from Drive", { guestListFileId });

  try {
    const drive = createDriveClient();
    content = await downloadGuestListContentAsText(drive, guestListFileId);
  } catch (error) {
    if (isInvalidGrantError(error) && hasServiceAccountConfig()) {
      logger.warn("OAuth grant became invalid; retrying guest list fetch with service_account", {
        guestListFileId
      });
      try {
        const fallbackDrive = createDriveClient("service_account");
        content = await downloadGuestListContentAsText(fallbackDrive, guestListFileId);
      } catch (fallbackError) {
        logger.error("Guest list fetch fallback with service_account failed", {
          guestListFileId,
          errorMessage: fallbackError?.message,
          errorCode: fallbackError?.code
        });
        throw fallbackError;
      }
    }

    if (error && isFileNotDownloadableError(error)) {
      const drive = createDriveClient();
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

  return ensureNamedFolder(process.env.GOOGLE_DRIVE_FOLDER_ID, folderName, guestFolderCache);
}

async function ensureNamedFolder(parentId, folderName, cache = null) {
  const safeParentId = resolveDriveFileId(parentId);
  const safeFolderName = sanitizeGuestName(folderName);

  if (!safeParentId) {
    logger.error("Parent folder id is invalid", { parentId });
    throw new Error("Pasta pai invalida.");
  }

  if (!safeFolderName) {
    logger.error("Named folder is invalid", { folderName });
    throw new Error("Nome de pasta invalido.");
  }

  if (cache && cache.has(safeFolderName)) {
    logger.info("Named folder served from cache", {
      folderName: safeFolderName,
      folderId: cache.get(safeFolderName)
    });
    return {
      id: cache.get(safeFolderName),
      name: safeFolderName,
      created: false
    };
  }

  const drive = createDriveClient();
  const escapedFolderName = safeFolderName.replace(/'/g, "\\'");

  logger.info("Resolving named folder on Drive", { folderName: safeFolderName, parentId: safeParentId });

  const lookup = await drive.files.list({
    q: [
      `mimeType = 'application/vnd.google-apps.folder'`,
      `name = '${escapedFolderName}'`,
      `'${safeParentId}' in parents`,
      `trashed = false`
    ].join(" and "),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: "files(id,name)",
    pageSize: 1
  });

  const existingFolder = lookup.data.files && lookup.data.files[0];
  if (existingFolder) {
    if (cache) {
      cache.set(safeFolderName, existingFolder.id);
    }
    logger.info("Existing named folder found", {
      folderName: safeFolderName,
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
      name: safeFolderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [safeParentId]
    },
    fields: "id,name"
  });

  if (cache) {
    cache.set(safeFolderName, createdFolder.data.id);
  }
  logger.info("Named folder created", {
    folderName: safeFolderName,
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
  runDriveOperation,
  ensureGuestFolder,
  ensureNamedFolder,
  formatGuestFolderName,
  getDriveAuthMode,
  isGuestOnList,
  isOriginAllowed,
  parseAllowedOrigins,
  resolveDriveFileId,
  sanitizeGuestName,
  validateRequiredEnv
};
