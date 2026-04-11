const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");
const { randomUUID } = require("node:crypto");
const {
  applyOriginHeaders,
  ensureNamedFolder,
  isOriginAllowed,
  parseAllowedOrigins,
  resolveDriveFileId,
  runDriveOperation,
  validateRequiredEnv
} = require("../lib/_drive");
const { requireAuth } = require("../lib/auth");
const { createLogger, createRequestLogger } = require("../lib/_logger");
const { enforceRateLimit } = require("../lib/rate-limit");

const stateLogger = createLogger("challenge-state");
const CHALLENGE_STATE_FILE = path.join(os.tmpdir(), "wedding-challenge-state.local.json");
const CHALLENGE_STATE_FILE_NAME = "wedding-challenge-state.json";
const CHALLENGE_FOLDER_NAME = "desafios";
const STATE_CACHE_TTL_MS = Math.max(1000, Number(process.env.CHALLENGE_STATE_CACHE_TTL_MS || 15000));
const VERBOSE_APP_LOGS = process.env.NODE_ENV !== "production" || process.env.ENABLE_VERBOSE_APP_LOGS === "true";

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

function normalizeText(value, fallback = "") {
  return String(value || "").trim() || fallback;
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === "object") {
    return req.body;
  }

  if (typeof req.body === "string") {
    return req.body ? JSON.parse(req.body) : {};
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function summarizeBody(body) {
  return {
    keys: Object.keys(body || {}),
    challengeTitle: String(body?.challengeTitle || "").slice(0, 120),
    prize: String(body?.prize || "").slice(0, 120),
    winner: String(body?.winner || "").slice(0, 120),
    hasRankings: Array.isArray(body?.rankings),
    rankingsCount: Array.isArray(body?.rankings) ? body.rankings.length : 0,
    resetGame: Boolean(body?.resetGame)
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

function normalizeRankings(rankings) {
  if (!Array.isArray(rankings)) {
    return getDefaultState().rankings;
  }

  const normalized = rankings
    .map((entry, index) => ({
      name: String(entry?.name || "").trim(),
      points: Number(entry?.points) || 0
    }))
    .slice(0, 8);

  return normalized.length > 0 ? normalized : getDefaultState().rankings;
}

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function challengeContentChanged(currentState, nextValues) {
  return (
    nextValues.challengeTitle !== currentState.challengeTitle ||
    nextValues.prize !== currentState.prize
  );
}

function normalizeRankingName(value) {
  return normalizeText(value).toLowerCase();
}

function updateRankingsForWinner(currentRankings, currentWinner, nextWinner) {
  const rankingMap = new Map(
    (normalizeRankings(currentRankings) || []).map((entry) => [
      normalizeRankingName(entry.name),
      { name: entry.name, points: Number(entry.points) || 0 }
    ])
  );

  const normalizedCurrentWinner = normalizeRankingName(currentWinner);
  const normalizedNextWinner = normalizeRankingName(nextWinner);

  if (normalizedCurrentWinner && normalizedNextWinner && normalizedCurrentWinner !== normalizedNextWinner) {
    const currentEntry = rankingMap.get(normalizedCurrentWinner);
    if (currentEntry) {
      currentEntry.points = Math.max(0, Number(currentEntry.points) - 1);
    }
  }

  if (normalizedNextWinner) {
    const nextEntry = rankingMap.get(normalizedNextWinner);
    if (nextEntry) {
      nextEntry.points = Number(nextEntry.points) + 1;
    } else {
      rankingMap.set(normalizedNextWinner, { name: nextWinner, points: 1 });
    }
  }

  const normalized = Array.from(rankingMap.values());
  normalized.sort((left, right) => {
    if (right.points !== left.points) {
      return right.points - left.points;
    }
    return left.name.localeCompare(right.name, "pt-BR");
  });
  while (normalized.length < 8) {
    normalized.push({ name: "", points: 0 });
  }
  return normalized.slice(0, 8);
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

async function buildHistoryEntry(state) {
  const photoNames = await listRoundPhotoNames(state.challengeNumber, state.challengeFolderName);
  return {
    id: randomUUID(),
    challengeNumber: state.challengeNumber,
    challengeTitle: state.challengeTitle,
    prize: state.prize,
    winner: state.winner,
    rankings: state.rankings,
    photoNames,
    closedAt: new Date().toISOString()
  };
}

const handler = async (req, res) => {
  const logger = createRequestLogger(req, "challenge");

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Challenge rejected due to unauthorized origin", { allowedOriginsCount: allowedOrigins.length });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  const rateLimitOptions =
    req.method === "GET"
      ? { scope: "challenge-read", limit: 60, windowMs: 60 * 1000 }
      : { scope: "challenge-write", limit: 15, windowMs: 60 * 1000 };
  if (!enforceRateLimit(req, res, logger, rateLimitOptions)) {
    return;
  }

  if (req.method === "GET") {
    const state = await readState();
    return res.status(200).json({ ok: true, challenge: state });
  }

  if (req.method !== "POST") {
    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  if (!requireAuth(req, res)) {
    logger.warn("Challenge update rejected because authentication failed");
    return;
  }

  try {
    const body = await readJsonBody(req);

    const currentState = await readState();
    const nextChallengeTitle = hasOwn(body, "challengeTitle")
      ? normalizeText(body.challengeTitle, currentState.challengeTitle)
      : currentState.challengeTitle;
    const nextPrize = hasOwn(body, "prize")
      ? normalizeText(body.prize, currentState.prize)
      : currentState.prize;
    const nextWinner = hasOwn(body, "winner")
      ? normalizeText(body.winner, "")
      : currentState.winner;
    const resetGame = Boolean(body.resetGame);
    let nextRankings = hasOwn(body, "rankings")
      ? normalizeRankings(body.rankings)
      : currentState.rankings;

    if (hasOwn(body, "winner") && nextWinner) {
      nextRankings = updateRankingsForWinner(nextRankings, currentState.winner, nextWinner);
    }

    const contentChanged = challengeContentChanged(currentState, {
      challengeTitle: nextChallengeTitle,
      prize: nextPrize
    });
    if (VERBOSE_APP_LOGS) {
      logger.info("Challenge payload accepted", summarizeBody(body));
    }

    const nextState = {
      ...currentState,
      challengeTitle: nextChallengeTitle,
      prize: nextPrize,
      winner: nextWinner,
      rankings: nextRankings,
      updatedAt: new Date().toISOString()
    };

    if (resetGame && currentState.roundClosedAt) {
      nextState.challengeNumber = 1;
      nextState.roundClosedAt = "";
      nextState.winner = "";
      nextState.rankings = getDefaultState().rankings;
      nextState.history = [];
      nextState.celebrationResult = null;
      nextState.challengeFolderName = createChallengeFolderName(nextChallengeTitle || nextPrize || currentState.challengeTitle);
    } else if (contentChanged && currentState.roundClosedAt) {
      nextState.challengeNumber = 1;
      nextState.roundClosedAt = "";
      nextState.winner = "";
      nextState.rankings = getDefaultState().rankings;
      nextState.history = [];
      nextState.celebrationResult = null;
      nextState.challengeFolderName = createChallengeFolderName(
        nextChallengeTitle || nextPrize || currentState.challengeTitle
      );
    } else {
      nextState.challengeNumber = Number(currentState.challengeNumber || 1);
      nextState.roundClosedAt = currentState.roundClosedAt;
      nextState.celebrationResult = contentChanged ? null : currentState.celebrationResult || null;
      if (currentState.roundClosedAt) {
        nextState.history = (currentState.history || []).map((entry) => {
          if (Number(entry.challengeNumber) !== Number(currentState.challengeNumber)) {
            return entry;
          }

          return {
            ...entry,
            challengeTitle: nextState.challengeTitle,
            prize: nextState.prize,
            winner: nextState.winner,
            rankings: nextState.rankings
          };
        });
      }
    }

    await writeState(nextState);

    return res.status(200).json({ ok: true, challenge: nextState });
  } catch (error) {
    logger.error("Challenge update failed", {
      errorMessage: error?.message,
      errorName: error?.name,
      requestBodyType: typeof req.body
    });
    return res.status(500).json({
      error: "Falha ao salvar desafio.",
      details: error?.message,
      requestId: logger.requestId
    });
  }
};

handler.readState = readState;
handler.writeState = writeState;
handler.getDefaultState = getDefaultState;
handler.listRoundPhotoNames = listRoundPhotoNames;
handler.createChallengeFolderName = createChallengeFolderName;

module.exports = handler;
