const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { randomUUID } = require("node:crypto");
const {
  ensureNamedFolder,
  resolveDriveFileId,
  runDriveOperation,
  validateRequiredEnv
} = require("./_drive");
const { createLogger } = require("./_logger");

const stateLogger = createLogger("challenge-state");
const CHALLENGE_STATE_FILE = path.join(os.tmpdir(), "wedding-challenge-state.local.json");
const CHALLENGE_STATE_FILE_NAME = "wedding-challenge-state.json";
const CHALLENGE_FOLDER_NAME = "desafios";
const STATE_CACHE_TTL_MS = Math.max(1000, Number(process.env.CHALLENGE_STATE_CACHE_TTL_MS || 15000));

let stateCache = {
  expiresAt: 0,
  value: null
};

function getDefaultState() {
  return {
    id: randomUUID(),
    challengeTitle: "",
    prize: "",
    challengeNumber: 1,
    winner: "",
    rankings: [
      { name: "", points: 0 },
      { name: "", points: 0 },
      { name: "", points: 0 }
    ],
    history: [],
    celebrationResult: null,
    roundClosedAt: "",
    challengeFolderName: CHALLENGE_FOLDER_NAME,
    updatedAt: new Date().toISOString()
  };
}

function mergeWithDefaultState(parsed) {
  return {
    ...getDefaultState(),
    ...parsed,
    rankings: Array.isArray(parsed?.rankings) ? parsed.rankings : getDefaultState().rankings,
    history: Array.isArray(parsed?.history) ? parsed.history : [],
    celebrationResult: parsed?.celebrationResult && typeof parsed.celebrationResult === "object"
      ? parsed.celebrationResult
      : null
  };
}

function readCachedState() {
  if (!stateCache.value || stateCache.expiresAt <= Date.now()) {
    return null;
  }

  return mergeWithDefaultState(stateCache.value);
}

function writeCachedState(state) {
  stateCache = {
    value: mergeWithDefaultState(state),
    expiresAt: Date.now() + STATE_CACHE_TTL_MS
  };
}

function canUseDriveState() {
  const authMode = String(process.env.GOOGLE_AUTH_MODE || "").trim().toLowerCase();
  const hasOauthConfig = Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN
  );
  const hasServiceAccountConfig = Boolean(
    process.env.GOOGLE_CLIENT_EMAIL && process.env.GOOGLE_PRIVATE_KEY_b64
  );

  if (!process.env.GOOGLE_DRIVE_FOLDER_ID || !process.env.GUEST_LIST_FILE_ID) {
    return false;
  }

  if (authMode === "oauth") {
    return hasOauthConfig || hasServiceAccountConfig;
  }

  if (authMode === "service_account") {
    return hasServiceAccountConfig;
  }

  return hasOauthConfig || hasServiceAccountConfig;
}

async function streamToString(stream) {
  const chunks = [];

  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function findStateFile(drive, folderId) {
  const response = await drive.files.list({
    q: [
      `'${folderId}' in parents`,
      `trashed = false`,
      `name = '${CHALLENGE_STATE_FILE_NAME}'`
    ].join(" and "),
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    fields: "files(id,name,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: 1
  });

  return response.data.files?.[0] || null;
}

async function readStateFromDrive() {
  validateRequiredEnv();
  const rootFolderId = resolveDriveFileId(process.env.GOOGLE_DRIVE_FOLDER_ID);

  return runDriveOperation(async (drive) => {
    const stateFile = await findStateFile(drive, rootFolderId);
    if (!stateFile?.id) {
      return null;
    }

    const downloaded = await drive.files.get(
      {
        fileId: stateFile.id,
        alt: "media",
        supportsAllDrives: true
      },
      {
        responseType: "stream"
      }
    );

    const raw = await streamToString(downloaded.data);
    return raw ? JSON.parse(raw) : null;
  }, { operationName: "challenge-state-read" });
}

async function writeStateToDrive(state) {
  validateRequiredEnv();
  const rootFolderId = resolveDriveFileId(process.env.GOOGLE_DRIVE_FOLDER_ID);
  const serialized = JSON.stringify(state, null, 2);

  return runDriveOperation(async (drive) => {
    const stateFile = await findStateFile(drive, rootFolderId);
    const media = {
      mimeType: "application/json; charset=utf-8",
      body: Readable.from([serialized], { encoding: "utf8" })
    };

    if (stateFile?.id) {
      await drive.files.update({
        fileId: stateFile.id,
        supportsAllDrives: true,
        requestBody: {
          name: CHALLENGE_STATE_FILE_NAME
        },
        media,
        fields: "id,name"
      });
      return;
    }

    await drive.files.create({
      supportsAllDrives: true,
      requestBody: {
        name: CHALLENGE_STATE_FILE_NAME,
        parents: [rootFolderId]
      },
      media,
      fields: "id,name"
    });
  }, { operationName: "challenge-state-write" });
}

async function readState() {
  const cachedState = readCachedState();
  if (cachedState) {
    return cachedState;
  }

  if (canUseDriveState()) {
    try {
      const driveState = await readStateFromDrive();
      if (driveState) {
        const nextState = mergeWithDefaultState(driveState);
        writeCachedState(nextState);
        return nextState;
      }
    } catch (error) {
      stateLogger.error("Failed to load challenge state from Drive", {
        errorMessage: error?.message
      });
    }
  }

  try {
    const raw = await fs.promises.readFile(CHALLENGE_STATE_FILE, "utf8");
    const nextState = mergeWithDefaultState(JSON.parse(raw));
    writeCachedState(nextState);
    return nextState;
  } catch {
    const nextState = getDefaultState();
    writeCachedState(nextState);
    return nextState;
  }
}

async function writeState(state) {
  writeCachedState(state);

  if (canUseDriveState()) {
    try {
      await writeStateToDrive(state);
      return;
    } catch (error) {
      stateLogger.error("Failed to write challenge state to Drive", {
        errorMessage: error?.message
      });
    }
  }

  await fs.promises.writeFile(CHALLENGE_STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

function createChallengeFolderName(title) {
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, "");
  const baseName = String(title || "desafios").trim() || "desafios";
  return `${baseName}_${timestamp}`;
}

async function listRoundPhotoNames(challengeNumber, folderName) {
  return runDriveOperation(async (drive) => {
    const challengeFolder = await ensureNamedFolder(
      process.env.GOOGLE_DRIVE_FOLDER_ID,
      folderName || CHALLENGE_FOLDER_NAME
    );
    const marker = `_${challengeNumber}_desafio_`;
    let pageToken;
    const photoNames = [];

    do {
      const response = await drive.files.list({
        q: [`'${challengeFolder.id}' in parents`, `trashed = false`].join(" and "),
        supportsAllDrives: true,
        includeItemsFromAllDrives: true,
        fields: "nextPageToken, files(name,mimeType)",
        pageToken,
        pageSize: 200,
        orderBy: "createdTime desc"
      });

      for (const file of response.data.files || []) {
        if (file.mimeType === "application/vnd.google-apps.folder") {
          continue;
        }
        if (String(file.name || "").includes(marker)) {
          photoNames.push(file.name);
        }
      }

      pageToken = response.data.nextPageToken;
    } while (pageToken);

    return photoNames;
  }, { operationName: "challenge-state-list-round-photos" });
}

module.exports = {
  CHALLENGE_FOLDER_NAME,
  createChallengeFolderName,
  getDefaultState,
  listRoundPhotoNames,
  readState,
  writeState
};
