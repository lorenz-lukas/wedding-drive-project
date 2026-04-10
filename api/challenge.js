const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  applyOriginHeaders,
  createDriveClient,
  ensureNamedFolder,
  isOriginAllowed,
  parseAllowedOrigins
} = require("../lib/_drive");
const { requireAuth } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");

const CHALLENGE_STATE_FILE = path.join(os.tmpdir(), "wedding-challenge-state.json");
const CHALLENGE_FOLDER_NAME = "desafios";

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

async function readState() {
  try {
    const raw = await fs.promises.readFile(CHALLENGE_STATE_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return {
      ...getDefaultState(),
      ...parsed,
      rankings: Array.isArray(parsed.rankings) ? parsed.rankings : getDefaultState().rankings,
      history: Array.isArray(parsed.history) ? parsed.history : [],
      celebrationResult: parsed.celebrationResult && typeof parsed.celebrationResult === "object"
        ? parsed.celebrationResult
        : null
    };
  } catch {
    return getDefaultState();
  }
}

async function writeState(state) {
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
  const drive = createDriveClient();
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
  logger.info("Challenge request received");

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Challenge rejected due to unauthorized origin", { allowedOriginsCount: allowedOrigins.length });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

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
    logger.info("Challenge updated successfully", {
      challengeId: nextState.id,
      rankingsCount: nextState.rankings.length
    });

    return res.status(200).json({ ok: true, challenge: nextState });
  } catch (error) {
    logger.error("Challenge update failed", {
      errorMessage: error?.message
    });
    return res.status(500).json({
      error: "Falha ao salvar desafio.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};

handler.readState = readState;
handler.writeState = writeState;
handler.getDefaultState = getDefaultState;
handler.listRoundPhotoNames = listRoundPhotoNames;
handler.createChallengeFolderName = createChallengeFolderName;

module.exports = handler;
