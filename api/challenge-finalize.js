const { Readable } = require("node:stream");
const {
  applyOriginHeaders,
  ensureNamedFolder,
  isOriginAllowed,
  parseAllowedOrigins,
  resolveDriveFileId,
  runDriveOperation,
  validateRequiredEnv
} = require("../lib/_drive");
const challengeHandler = require("./challenge");
const { requireAuth } = require("../lib/auth");
const { createRequestLogger } = require("../lib/_logger");

const CHALLENGE_FOLDER_NAME = "desafios";

function normalizeName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractSubmitterName(fileName, challengeNumber) {
  const marker = `_${challengeNumber}_desafio_`;
  const index = String(fileName || "").indexOf(marker);
  if (index <= 0) {
    return "";
  }
  return fileName.slice(0, index).replace(/_/g, " ").trim();
}

function escapeCsv(value) {
  const stringValue = String(value ?? "");
  const escaped = stringValue.replace(/"/g, "\"\"");
  return `"${escaped}"`;
}

function buildCsvContent(challenge, activePhotoNames) {
  const rows = [
    [
      "tipo",
      "numero_desafio",
      "titulo",
      "premio",
      "vencedor",
      "participante",
      "pontos",
      "nome_da_foto"
    ]
  ];

  const rounds = [...(challenge.history || [])];
  if (!challenge.roundClosedAt || !rounds.some((entry) => entry.challengeNumber === challenge.challengeNumber)) {
    rounds.push({
      challengeNumber: challenge.challengeNumber,
      challengeTitle: challenge.challengeTitle,
      prize: challenge.prize,
      winner: challenge.winner,
      rankings: challenge.rankings || [],
      photoNames: activePhotoNames
    });
  }

  for (const round of rounds) {
    rows.push([
      "desafio",
      round.challengeNumber,
      round.challengeTitle,
      round.prize,
      round.winner,
      "",
      "",
      ""
    ]);

    for (const entry of round.rankings || []) {
      rows.push([
        "ranking",
        round.challengeNumber,
        round.challengeTitle,
        "",
        "",
        entry.name,
        entry.points,
        ""
      ]);
    }

    for (const photoName of round.photoNames || []) {
      rows.push([
        "foto",
        round.challengeNumber,
        round.challengeTitle,
        "",
        "",
        "",
        "",
        photoName
      ]);
    }
  }

  return `${rows.map((row) => row.map(escapeCsv).join(",")).join("\n")}\n`;
}

async function listChallengePhotoNames(drive, folderId, challengeNumber) {
  let pageToken;
  const fileNames = [];
  const marker = `_${challengeNumber}_desafio_`;

  do {
    const response = await drive.files.list({
      q: [`'${folderId}' in parents`, `trashed = false`].join(" and "),
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: "nextPageToken, files(name,mimeType)",
      pageToken,
      pageSize: 200,
      orderBy: "createdTime desc"
    });

    const files = response.data.files || [];
    for (const file of files) {
      if (file.mimeType === "application/vnd.google-apps.folder") {
        continue;
      }
      if (String(file.name || "").includes(marker)) {
        fileNames.push(file.name);
      }
    }

    pageToken = response.data.nextPageToken;
  } while (pageToken);

  return fileNames;
}

module.exports = async (req, res) => {
  const logger = createRequestLogger(req, "challenge-finalize");
  logger.info("Challenge finalize request received");

  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Metodo nao permitido." });
  }

  const allowedOrigins = parseAllowedOrigins();
  if (!isOriginAllowed(req, allowedOrigins)) {
    logger.warn("Challenge finalize rejected due to unauthorized origin", {
      allowedOriginsCount: allowedOrigins.length
    });
    return res.status(403).json({ error: "Origem nao autorizada." });
  }

  applyOriginHeaders(req, res, allowedOrigins);

  if (!requireAuth(req, res)) {
    logger.warn("Challenge finalize rejected because authentication failed");
    return;
  }

  try {
    validateRequiredEnv();
    logger.info("Challenge finalize env validated", {
      hasDriveFolderId: Boolean(process.env.GOOGLE_DRIVE_FOLDER_ID),
      hasGuestListFileId: Boolean(process.env.GUEST_LIST_FILE_ID)
    });

    const requestBody = await new Promise((resolve, reject) => {
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

    const challenge = await challengeHandler.readState();
    const finish = Boolean(requestBody?.finish);
    const winner = String(requestBody?.winner || "").trim() || String(challenge.winner || "").trim();
    logger.info("Challenge finalize payload parsed", {
      finish,
      challengeId: challenge.id,
      challengeNumber: challenge.challengeNumber,
      challengeTitle: challenge.challengeTitle,
      prize: challenge.prize,
      winner,
      rankingsCount: Array.isArray(challenge.rankings) ? challenge.rankings.length : 0,
      historyCount: Array.isArray(challenge.history) ? challenge.history.length : 0,
      challengeFolderName: challenge.challengeFolderName
    });

    const rootFolderId = resolveDriveFileId(process.env.GOOGLE_DRIVE_FOLDER_ID);
    logger.info("Challenge finalize resolved root folder id", {
      hasRootFolderId: Boolean(rootFolderId),
      rootFolderIdPreview: rootFolderId ? `${rootFolderId.slice(0, 6)}...${rootFolderId.slice(-4)}` : null
    });
    const challengeFolder = await ensureNamedFolder(rootFolderId, challenge.challengeFolderName || CHALLENGE_FOLDER_NAME);
    logger.info("Challenge finalize resolved challenge folder", {
      challengeFolderId: challengeFolder.id,
      challengeFolderName: challengeFolder.name,
      challengeFolderCreated: challengeFolder.created
    });
    const photoNames = await runDriveOperation(
        (drive) => listChallengePhotoNames(drive, challengeFolder.id, challenge.challengeNumber),
        { operationName: "challenge-finalize-list-photos" }
      );
    logger.info("Challenge finalize loaded round photos", {
      challengeNumber: challenge.challengeNumber,
      photoCount: photoNames.length,
      photoSamples: photoNames.slice(0, 5)
    });

    const participantNames = Array.from(
      new Map(
        photoNames
          .map((photoName) => {
            const guestName = extractSubmitterName(photoName, challenge.challengeNumber);
            return [normalizeName(guestName), guestName];
          })
          .filter(([normalizedName, guestName]) => normalizedName && guestName)
      ).values()
    );
    logger.info("Challenge finalize extracted participants", {
      participantCount: participantNames.length,
      participantsSample: participantNames.slice(0, 8)
    });

    const rankingMap = new Map(
      (challenge.rankings || [])
        .filter((entry) => entry?.name)
        .map((entry) => [normalizeName(entry.name), { name: entry.name, points: Number(entry.points) || 0 }])
    );

    for (const participantName of participantNames) {
      const normalizedName = normalizeName(participantName);
      if (!rankingMap.has(normalizedName)) {
        rankingMap.set(normalizedName, { name: participantName, points: 0 });
      }
    }

    const normalizedWinner = normalizeName(winner);
    if (normalizedWinner) {
      const existingWinner = rankingMap.get(normalizedWinner);
      rankingMap.set(normalizedWinner, {
        name: winner,
        points: (existingWinner?.points || 0) + 1
      });
    }

    const nextRankings = Array.from(rankingMap.values()).sort((left, right) => {
      if (right.points !== left.points) {
        return right.points - left.points;
      }
      return left.name.localeCompare(right.name, "pt-BR");
    });
    logger.info("Challenge finalize computed rankings", {
      nextRankingsCount: nextRankings.length,
      topRankings: nextRankings.slice(0, 5)
    });

    const closedAt = new Date().toISOString();
    const nextHistoryEntry = {
      id: `${challenge.challengeNumber}-${closedAt}`,
      challengeNumber: challenge.challengeNumber,
      challengeTitle: challenge.challengeTitle,
      prize: challenge.prize,
      winner,
      rankings: nextRankings,
      photoNames,
      closedAt
    };

    const nextHistory = (challenge.history || []).some(
      (entry) => Number(entry.challengeNumber) === Number(challenge.challengeNumber)
    )
      ? (challenge.history || []).map((entry) =>
          Number(entry.challengeNumber) === Number(challenge.challengeNumber) ? nextHistoryEntry : entry
        )
      : [...(challenge.history || []), nextHistoryEntry];

    const nextChallengeNumber = Number(challenge.challengeNumber || 1) + 1;
    const nextChallenge = {
      ...challenge,
      winner: "",
      challengeTitle: "",
      prize: "",
      rankings: nextRankings,
      challengeNumber: nextChallengeNumber,
      roundClosedAt: "",
      history: nextHistory
    };

    const stateToWrite = finish
      ? (() => {
          const nextGame = challengeHandler.getDefaultState();
          nextGame.challengeFolderName = challengeHandler.createChallengeFolderName(
            challenge.challengeTitle || challenge.prize || "desafios"
          );
          nextGame.celebrationResult = nextHistoryEntry;
          nextGame.updatedAt = closedAt;
          return nextGame;
        })()
      : {
          ...nextChallenge,
          celebrationResult: null,
          finalizedAt: closedAt,
          finalizedCsvName: "",
          updatedAt: closedAt
        };

    logger.info("Challenge finalize writing next state", {
      finish,
      nextChallengeNumber: stateToWrite.challengeNumber,
      nextChallengeTitle: stateToWrite.challengeTitle,
      nextPrize: stateToWrite.prize,
      nextRoundClosedAt: stateToWrite.roundClosedAt,
      nextHistoryCount: Array.isArray(stateToWrite.history) ? stateToWrite.history.length : 0,
      nextChallengeFolderName: stateToWrite.challengeFolderName
    });
    await challengeHandler.writeState(stateToWrite);

    const finalizedChallenge = {
      ...challenge,
      winner,
      rankings: nextRankings,
      roundClosedAt: closedAt,
      history: nextHistory
    };

    const csvContent = buildCsvContent(finalizedChallenge, []);
    const timestamp = new Date().toISOString().replace(/[.:]/g, "-");
    const fileName = `desafios_${timestamp}.csv`;
    logger.info("Challenge finalize built CSV content", {
      fileName,
      csvLength: csvContent.length,
      csvLineCount: csvContent.split("\n").filter(Boolean).length,
      finalizedHistoryCount: finalizedChallenge.history.length
    });

    let created = null;
    let csvErrorMessage = "";

    try {
      logger.info("Challenge finalize creating CSV on Drive", {
        fileName,
        parentFolderIdPreview: rootFolderId ? `${rootFolderId.slice(0, 6)}...${rootFolderId.slice(-4)}` : null
      });
      created = await runDriveOperation(
        (drive) =>
          drive.files.create({
            supportsAllDrives: true,
            requestBody: {
              name: fileName,
              parents: [rootFolderId]
            },
            media: {
              mimeType: "text/csv; charset=utf-8",
              body: Readable.from([csvContent], { encoding: "utf8" })
            },
            fields: "id,name"
          }),
        { operationName: "challenge-finalize-create-csv" }
      );
    } catch (error) {
      csvErrorMessage = error?.message || "Falha ao gerar arquivo CSV dos desafios.";
      logger.error("Challenge finalize CSV generation failed after state update", {
        errorMessage: error?.message,
        errorCode: error?.code,
        errorStatus: error?.response?.status,
        errorData: error?.response?.data,
        fileName,
        rootFolderIdPreview: rootFolderId ? `${rootFolderId.slice(0, 6)}...${rootFolderId.slice(-4)}` : null,
        challengeFolderId: challengeFolder.id,
        csvLength: csvContent.length,
        finish
      });
    }

    if (created?.data) {
      logger.info("Challenge CSV created successfully", {
        csvFileId: created.data.id,
        csvFileName: created.data.name,
        photoCount: photoNames.length
      });
    }

    return res.status(200).json({
      ok: true,
      file: created?.data || null,
      photoCount: photoNames.length,
      csvSaved: Boolean(created?.data),
      warning: csvErrorMessage || undefined
    });
  } catch (error) {
    logger.error("Challenge finalize failed", {
      errorMessage: error?.message,
      errorCode: error?.code,
      errorStatus: error?.response?.status,
      errorData: error?.response?.data
    });
    return res.status(500).json({
      error: "Falha ao gerar arquivo CSV dos desafios.",
      details: process.env.NODE_ENV === "development" ? error.message : undefined
    });
  }
};
