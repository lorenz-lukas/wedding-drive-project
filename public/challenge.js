const AUTH_TOKEN_KEY = "casamento_auth_token";
const CHALLENGE_NAME_CACHE_KEY = "casamento_desafio_nome";
const CHALLENGE_SYNC_KEY = "casamento_challenge_sync";
const DEFAULT_CHALLENGE_POLL_INTERVAL_MS = parseInt(window.CHALLENGE_POLL_INTERVAL_MS || "120000", 10);
const UPLOAD_CHALLENGE_POLL_INTERVAL_MS = parseInt(window.CHALLENGE_UPLOAD_POLL_INTERVAL_MS || "180000", 10);

const pageMode = document.body?.dataset?.challengePage || "";

const authModalShell = document.getElementById("auth-modal-shell");
const authForm = document.getElementById("auth-form");
const authStatus = document.getElementById("auth-status");
const authUsernameInput = document.getElementById("authUsername");
const authPasswordInput = document.getElementById("authPassword");
const challengeSyncChannel =
  typeof window !== "undefined" && "BroadcastChannel" in window
    ? new BroadcastChannel("casamento_challenge_sync")
    : null;

function getAuthToken() {
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

function saveAuthToken(token) {
  try {
    if (token) {
      localStorage.setItem(AUTH_TOKEN_KEY, token);
      return;
    }

    localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {}
}

function openAuthModal() {
  if (!authModalShell) return;
  authModalShell.classList.remove("hidden");
  authModalShell.setAttribute("aria-hidden", "false");
  window.setTimeout(() => authUsernameInput?.focus(), 30);
}

function closeAuthModal() {
  if (!authModalShell) return;
  authModalShell.classList.add("hidden");
  authModalShell.setAttribute("aria-hidden", "true");
  if (authStatus) {
    authStatus.textContent = "";
  }
}

async function login(username, password) {
  const response = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Credenciais invalidas.");
  }

  return payload.token;
}

if (authForm) {
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (authStatus) {
      authStatus.textContent = "Verificando...";
    }

    try {
      const token = await login(authUsernameInput?.value?.trim(), authPasswordInput?.value || "");
      saveAuthToken(token);
      closeAuthModal();
    } catch (error) {
      if (authStatus) {
        authStatus.textContent = error.message || "Erro ao autenticar.";
      }
    }
  });
}

async function challengeRequest(method, body) {
  const headers = { "Content-Type": "application/json" };
  const token = getAuthToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch("/api/challenge", {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  if (response.status === 401) {
    openAuthModal();
    throw new Error("Sessao expirada. Entre novamente.");
  }

  if (!response.ok) {
    const statusLine = `HTTP ${response.status}.`;
    const requestIdLine = payload.requestId ? ` Request ID: ${payload.requestId}.` : "";
    const detail = [payload.error, payload.details, !payload.error && rawText ? rawText : ""]
      .filter(Boolean)
      .join(" ");
    throw new Error((detail || "Falha ao salvar desafio.") + ` ${statusLine}${requestIdLine}`);
  }

  return payload.challenge;
}

async function challengeFinalizeRequest(body) {
  const headers = {};
  const token = getAuthToken();

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch("/api/challenge-finalize", {
    method: "POST",
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  const rawText = await response.text();
  let payload = {};
  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  if (response.status === 401) {
    openAuthModal();
    throw new Error("Sessao expirada. Entre novamente.");
  }

  if (!response.ok) {
    const requestIdLine = payload.requestId ? ` Request ID: ${payload.requestId}.` : "";
    const errorMessage = [payload.error, payload.details, !payload.error && rawText ? rawText : ""]
      .filter(Boolean)
      .join(" ");
    throw new Error((errorMessage || "Falha ao gerar CSV dos desafios.") + requestIdLine);
  }

  return payload;
}

async function fetchChallenge() {
  const response = await fetch("/api/challenge", { cache: "no-store" });
  const payload = await response.json();

  if (!response.ok) {
    throw new Error(payload.error || "Falha ao carregar desafio.");
  }

  return payload.challenge;
}

async function fetchChallengeSubmissions() {
  const response = await fetch("/api/challenge-submissions-feed", { cache: "no-store" });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    throw new Error(payload.error || "Falha ao carregar imagens do desafio.");
  }

  return payload;
}

function setStatus(element, message, type = "info") {
  if (!element) return;
  element.textContent = message;
  element.dataset.statusType = type;
}

function normalizePersonName(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function notifyChallengeUpdated(reason) {
  const payload = {
    reason: reason || "updated",
    timestamp: new Date().toISOString()
  };

  try {
    localStorage.setItem(CHALLENGE_SYNC_KEY, JSON.stringify(payload));
  } catch {}

  try {
    challengeSyncChannel?.postMessage(payload);
  } catch {}
}

function buildRankingRows(container, rankings, options = {}) {
  if (!container) return;
  const medals = ["Ouro", "Prata", "Bronze"];
  const editable = Boolean(options.editable);
  container.innerHTML = "";

  rankings.forEach((entry, index) => {
    const row = document.createElement("div");
    row.className = "challenge-ranking-row";

    const medal = document.createElement("div");
    medal.className = `challenge-ranking-medal${index < 3 ? ` is-top-${index + 1}` : ""}`;
    medal.textContent = medals[index] || `${index + 1}o`;

    if (editable) {
      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.className = "challenge-ranking-name";
      nameInput.dataset.rankingField = "name";
      nameInput.dataset.rankingIndex = String(index);
      nameInput.maxLength = 80;
      nameInput.placeholder = `Participante ${index + 1}`;
      nameInput.value = entry.name || "";

      const pointsInput = document.createElement("input");
      pointsInput.type = "number";
      pointsInput.className = "challenge-ranking-points";
      pointsInput.dataset.rankingField = "points";
      pointsInput.dataset.rankingIndex = String(index);
      pointsInput.min = "0";
      pointsInput.step = "1";
      pointsInput.value = String(Number(entry.points) || 0);

      row.append(medal, nameInput, pointsInput);
    } else {
      const nameValue = document.createElement("div");
      nameValue.className = "challenge-ranking-value";
      nameValue.textContent = entry.name || `Participante ${index + 1}`;

      const pointsValue = document.createElement("div");
      pointsValue.className = "challenge-ranking-score";
      pointsValue.textContent = `${Number(entry.points) || 0} pts`;

      row.append(medal, nameValue, pointsValue);
    }

    container.appendChild(row);
  });
}

function renderChallengeGallery(container, photos) {
  if (!container) return;
  container.innerHTML = "";
  const photoCount = photos?.length || 0;
  
  const minSize =
    photoCount > 200 ? "2.5rem" :
    photoCount > 150 ? "3.125rem" :
    photoCount > 100 ? "3.75rem" :
    photoCount > 80 ? "4.4rem" :
    photoCount > 48 ? "5.2rem" :
    photoCount > 24 ? "6.3rem" :
    photoCount > 12 ? "8rem" :
    "50px";

  container.style.setProperty("--challenge-gallery-count", String(Math.max(photoCount, 1)));
  container.style.setProperty("--challenge-gallery-min", minSize);

  if (!Array.isArray(photos) || photos.length === 0) {
    const empty = document.createElement("div");
    empty.className = "challenge-gallery-empty";
    empty.textContent = "Nenhuma imagem visivel nesta rodada.";
    container.appendChild(empty);
    return;
  }

  photos.forEach((photo) => {
    const card = document.createElement("article");
    card.className = "challenge-gallery-card";

    const image = document.createElement("img");
    image.className = "challenge-gallery-image";
    image.src = photo.src;
    image.alt = photo.guestName ? `Imagem enviada por ${photo.guestName}` : "Imagem do desafio";

    const caption = document.createElement("p");
    caption.className = "challenge-gallery-caption";
    caption.textContent = photo.guestName || photo.name || "Convidado";

    card.append(image, caption);
    container.appendChild(card);
  });
}

function renderChallengeRankingTable(container, challenge, photos) {
  if (!container) return;

  const pointsByGuest = new Map(
    (challenge?.rankings || [])
      .filter((entry) => entry?.name)
      .map((entry) => [normalizePersonName(entry.name), Number(entry.points) || 0])
  );

  const guestMap = new Map();

  (photos || [])
    .filter((photo) => photo?.guestName)
    .forEach((photo) => {
      const normalized = normalizePersonName(photo.guestName);
      if (!normalized) return;
      if (!guestMap.has(normalized)) {
        guestMap.set(normalized, photo.guestName);
      }
    });

  (challenge?.rankings || [])
    .filter((entry) => entry?.name)
    .forEach((entry) => {
      const normalized = normalizePersonName(entry.name);
      if (!normalized) return;
      if (!guestMap.has(normalized)) {
        guestMap.set(normalized, entry.name);
      }
    });

  const guests = Array.from(guestMap.entries())
    .map(([normalizedName, guestName]) => ({
      guestName,
      normalizedName,
      points: pointsByGuest.get(normalizedName) || 0
    }))
    .sort((left, right) => {
      if (right.points !== left.points) {
        return right.points - left.points;
      }
      return left.guestName.localeCompare(right.guestName, "pt-BR");
    });

  if (guests.length === 0) {
    container.innerHTML = `
      <div class="challenge-ranking-empty">
        O placar vai aparecer aqui assim que os convidados enviarem imagens.
      </div>
    `;
    return;
  }

  const bodyFontSize =
    guests.length > 120 ? "0.53rem" :
    guests.length > 90 ? "0.58rem" :
    guests.length > 60 ? "0.64rem" :
    guests.length > 36 ? "0.72rem" :
    "0.84rem";
  const headerFontSize =
    guests.length > 120 ? "0.46rem" :
    guests.length > 90 ? "0.5rem" :
    guests.length > 60 ? "0.56rem" :
    guests.length > 36 ? "0.62rem" :
    "0.68rem";

  const medals = ["🥇", "🥈", "🥉"];
  const table = document.createElement("table");
  table.className = "challenge-ranking-data-table";
  table.style.setProperty("--challenge-rank-body-size", bodyFontSize);
  table.style.setProperty("--challenge-rank-head-size", headerFontSize);
  table.innerHTML = `
    <thead>
      <tr>
        <th>#</th>
        <th>Participante</th>
        <th>Pontos</th>
      </tr>
    </thead>
    <tbody>
      ${guests
        .map(
          (guest, index) => `
            <tr>
              <td>${medals[index] || index + 1}</td>
              <td>${guest.guestName}</td>
              <td>${guest.points}</td>
            </tr>
          `
        )
        .join("")}
    </tbody>
  `;

  container.innerHTML = "";
  container.appendChild(table);
}

function updateWinnerOptions(select, photos, currentChallenge) {
  if (!select) return;

  const allEntries = [
    ...(photos || [])
      .filter((photo) => photo?.guestName)
      .map((photo) => [normalizePersonName(photo.guestName), photo.guestName]),
    ...(currentChallenge?.winner
      ? [[normalizePersonName(currentChallenge.winner), currentChallenge.winner]]
      : [])
  ];

  const names = Array.from(new Map(allEntries).values()).sort((left, right) =>
    left.localeCompare(right, "pt-BR")
  );

  const currentValue = select.value;
  select.innerHTML = '<option value="">Selecione o vencedor</option>';

  names.forEach((name) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    select.appendChild(option);
  });

  if (names.includes(currentValue)) {
    select.value = currentValue;
  }
}

async function initCreatePage() {
  const form = document.getElementById("challenge-create-form");
  const status = document.getElementById("challenge-create-status");
  const adminStatus = document.getElementById("challenge-admin-status");
  const titleInput = document.getElementById("challengeTitle");
  const prizeInput = document.getElementById("prize");
  const rankingTable = document.getElementById("challenge-admin-ranking-table");
  const winnerInput = document.getElementById("challengeWinner");
  const saveWinnerButton = document.getElementById("challenge-save-winner-button");
  const finalizeButton = document.getElementById("challenge-finalize-button");
  const roundNumberDisplay = document.getElementById("challenge-round-number");
  let currentChallenge = null;
  let currentPhotos = [];
  let localWinnerSelection = "";

  function applyChallengeToAdmin(challenge) {
    const isSameRound = currentChallenge && Number(currentChallenge.challengeNumber) === Number(challenge.challengeNumber);
    if (!isSameRound) {
      localWinnerSelection = "";
    }
    currentChallenge = challenge;
    if (roundNumberDisplay) {
      roundNumberDisplay.textContent = `- Rodada ${Number(challenge.challengeNumber || 1)}`;
    }
    if (document.activeElement !== titleInput) {
      titleInput.value = challenge.challengeTitle || "";
    }
    if (document.activeElement !== prizeInput) {
      prizeInput.value = challenge.prize || "";
    }
    if (saveWinnerButton) {
      saveWinnerButton.textContent = `Ir para rodada ${Number(challenge.challengeNumber || 1) + 1}`;
    }
    if (winnerInput) {
      winnerInput.value = localWinnerSelection || challenge.winner || "";
    }
    renderChallengeRankingTable(rankingTable, challenge, currentPhotos);
  }

  async function refreshAdminSubmissions() {
    const payload = await fetchChallengeSubmissions();
    currentPhotos = payload.photos || [];
    if (currentChallenge) {
      renderChallengeRankingTable(rankingTable, currentChallenge, currentPhotos);
    }
    updateWinnerOptions(winnerInput, currentPhotos, currentChallenge);
  }

  if (winnerInput) {
    winnerInput.addEventListener("change", () => {
      localWinnerSelection = winnerInput.value.trim();
    });
  }

  if (getAuthToken()) {
    closeAuthModal();
  } else {
    openAuthModal();
  }

  try {
    const challenge = await fetchChallenge();
    applyChallengeToAdmin(challenge);
    await refreshAdminSubmissions();
  } catch (error) {
    setStatus(status, error.message || "Nao foi possivel carregar o desafio.", "error");
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    setStatus(status, "Salvando desafio...");

    try {
      const challenge = await challengeRequest("POST", {
        challengeTitle: titleInput.value.trim(),
        prize: prizeInput.value.trim(),
        resetGame: Boolean(currentChallenge?.roundClosedAt)
      });
      applyChallengeToAdmin(challenge);
      await refreshAdminSubmissions();
      notifyChallengeUpdated("challenge-saved");
      setStatus(status, "Desafio salvo com sucesso.", "success");
    } catch (error) {
      setStatus(status, error.message || "Falha ao salvar desafio.", "error");
    }
  });

  finalizeButton?.addEventListener("click", async () => {
    const winner = winnerInput.value.trim() || currentChallenge?.winner?.trim() || "";

    finalizeButton.disabled = true;
    setStatus(
      adminStatus,
      winner
        ? "Finalizando rodada e gerando CSV..."
        : "Finalizando rodada sem vencedor e gerando CSV..."
    );

    try {
      const result = await challengeFinalizeRequest({ winner, finish: true });
      localWinnerSelection = "";
      const challenge = await fetchChallenge();
      applyChallengeToAdmin(challenge);
      await refreshAdminSubmissions();
      notifyChallengeUpdated("challenge-finished");
      setStatus(
        adminStatus,
        result.csvSaved
          ? `Desafios encerrados. CSV salvo no Drive como ${result.file?.name || "arquivo.csv"} com ${result.photoCount || 0} foto(s).`
          : `Desafios encerrados, mas o CSV nao foi gerado. ${result.warning || ""}`.trim(),
        result.csvSaved ? "success" : "error"
      );
    } catch (error) {
      setStatus(adminStatus, error.message || "Falha ao finalizar desafios.", "error");
    } finally {
      finalizeButton.disabled = false;
    }
  });

  saveWinnerButton?.addEventListener("click", async () => {
    const winner = winnerInput.value.trim() || currentChallenge?.winner?.trim() || "";
    if (!winner) {
      setStatus(adminStatus, "Selecione quem ganhou a rodada.", "error");
      return;
    }

    saveWinnerButton.disabled = true;
    setStatus(adminStatus, "Indo para a próxima rodada...");

    try {
      localWinnerSelection = "";
      const result = await challengeFinalizeRequest({ winner });
      const challenge = await fetchChallenge();
      applyChallengeToAdmin(challenge);
      await refreshAdminSubmissions();
      notifyChallengeUpdated("challenge-next-round");
      setStatus(
        adminStatus,
        result.csvSaved
          ? "Pronto! Agora você está na próxima rodada."
          : `Proxima rodada iniciada, mas o CSV nao foi gerado. ${result.warning || ""}`.trim(),
        result.csvSaved ? "success" : "error"
      );
    } catch (error) {
      setStatus(adminStatus, error.message || "Falha ao ir para a próxima rodada.", "error");
    } finally {
      saveWinnerButton.disabled = false;
    }
  });

  window.setInterval(async () => {
    try {
      const challenge = await fetchChallenge();
      applyChallengeToAdmin(challenge);
      await refreshAdminSubmissions();
    } catch {}
  }, DEFAULT_CHALLENGE_POLL_INTERVAL_MS);
}

async function initBoardPage() {
  const rankingTable = document.getElementById("challenge-ranking-table");
  const title = document.getElementById("challenge-board-title");
  const roundDisplay = document.getElementById("challenge-board-round");
  const prize = document.getElementById("challenge-board-prize");
  const winnerDisplay = document.getElementById("challenge-board-winner-display");
  const qrImage = document.getElementById("challenge-qr-image");
  const uploadLink = document.getElementById("challenge-upload-link");
  const galleryGrid = document.getElementById("challenge-gallery-grid");
  const galleryModalShell = document.getElementById("challenge-gallery-modal-shell");
  const openGalleryButton = document.getElementById("challenge-open-gallery");
  const closeGalleryButton = document.getElementById("challenge-gallery-close");
  const closeGalleryBackdrop = document.querySelector("[data-close-challenge-gallery]");
  const podiumOverlayShell = document.getElementById("challenge-podium-overlay-shell");
  const podiumOverlayStage = document.getElementById("challenge-podium-overlay-stage");
  const podiumOverlayCopy = document.getElementById("challenge-podium-overlay-copy");
  const confettiLayer = document.getElementById("challenge-confetti-layer");
  let currentUpdatedAt = "";
  let currentChallenge = null;
  let currentPhotos = [];
  let lastCelebrationKey = "";

  if (getAuthToken()) {
    closeAuthModal();
  } else {
    openAuthModal();
  }

  function openGalleryModal() {
    if (!galleryModalShell) return;
    galleryModalShell.classList.remove("hidden");
    galleryModalShell.setAttribute("aria-hidden", "false");
  }

  function closeGalleryModal() {
    if (!galleryModalShell) return;
    galleryModalShell.classList.add("hidden");
    galleryModalShell.setAttribute("aria-hidden", "true");
  }

  function shouldShowCelebrationOverlay(challenge) {
    return Boolean(challenge?.celebrationResult);
  }

  function getLatestFinishedRound(challenge) {
    return challenge?.celebrationResult || null;
  }

  function launchConfetti() {
    if (!confettiLayer) return;

    confettiLayer.innerHTML = "";
    const colors = ["#f2c55f", "#ab93c8", "#7d679f", "#f08c6c", "#7fb069", "#ffffff"];

    for (let index = 0; index < 34; index += 1) {
      const piece = document.createElement("span");
      piece.className = "challenge-confetti-piece";
      piece.style.left = `${Math.random() * 100}%`;
      piece.style.background = colors[index % colors.length];
      piece.style.animationDelay = `${Math.random() * 0.45}s`;
      piece.style.animationDuration = `${3.2 + Math.random() * 1.6}s`;
      piece.style.transform = `translate3d(0, -12vh, 0) rotate(${Math.random() * 360}deg)`;
      piece.style.opacity = String(0.78 + Math.random() * 0.22);
      piece.style.setProperty("--confetti-drift", `${-90 + Math.random() * 180}px`);
      confettiLayer.appendChild(piece);
    }
  }

  function renderCelebrationOverlay(challenge) {
    if (!podiumOverlayShell || !podiumOverlayStage || !podiumOverlayCopy) return;

    const latestRound = getLatestFinishedRound(challenge);
    if (!latestRound || !shouldShowCelebrationOverlay(challenge)) {
      podiumOverlayShell.classList.add("hidden");
      podiumOverlayShell.setAttribute("aria-hidden", "true");
      podiumOverlayStage.innerHTML = "";
      if (confettiLayer) {
        confettiLayer.innerHTML = "";
      }
      lastCelebrationKey = "";
      return;
    }

    const topEntries = (latestRound.rankings || [])
      .filter((entry) => entry?.name)
      .map((entry) => ({
        name: entry.name,
        points: Number(entry.points) || 0
      }))
      .sort((left, right) => {
        if (right.points !== left.points) {
          return right.points - left.points;
        }
        return left.name.localeCompare(right.name, "pt-BR");
      })
      .slice(0, 3);

    if (topEntries.length === 0) {
      podiumOverlayShell.classList.add("hidden");
      podiumOverlayShell.setAttribute("aria-hidden", "true");
      podiumOverlayStage.innerHTML = "";
      return;
    }

    const [first = { name: "-", points: 0 }, second = { name: "-", points: 0 }, third = { name: "-", points: 0 }] = topEntries;
    const winnerName = latestRound.winner || first.name;
    podiumOverlayCopy.textContent = `Rodada ${Number(latestRound.challengeNumber || 1)} encerrada. ${winnerName} lidera a celebração até o próximo desafio entrar no ar.`;
    podiumOverlayStage.innerHTML = `
      <article class="challenge-podium-f1-card challenge-podium-f1-card-second" style="animation-delay: 0.18s;">
        <div class="challenge-podium-f1-trophy" aria-hidden="true">🏆</div>
        <span class="challenge-podium-f1-place">2º lugar</span>
        <strong>${escapeHtml(second.name)}</strong>
        <span class="challenge-podium-f1-points">${second.points} pts</span>
      </article>
      <article class="challenge-podium-f1-card challenge-podium-f1-card-first" style="animation-delay: 0s;">
        <div class="challenge-podium-f1-crown" aria-hidden="true">VENCEDOR</div>
        <div class="challenge-podium-f1-trophy" aria-hidden="true">🏆</div>
        <span class="challenge-podium-f1-place">1º lugar</span>
        <strong>${escapeHtml(first.name)}</strong>
        <span class="challenge-podium-f1-points">${first.points} pts</span>
      </article>
      <article class="challenge-podium-f1-card challenge-podium-f1-card-third" style="animation-delay: 0.32s;">
        <div class="challenge-podium-f1-trophy" aria-hidden="true">🏆</div>
        <span class="challenge-podium-f1-place">3º lugar</span>
        <strong>${escapeHtml(third.name)}</strong>
        <span class="challenge-podium-f1-points">${third.points} pts</span>
      </article>
    `;
    podiumOverlayShell.classList.remove("hidden");
    podiumOverlayShell.setAttribute("aria-hidden", "false");
    const celebrationKey = `${latestRound.id || latestRound.challengeNumber || "round"}-${winnerName}`;
    if (celebrationKey !== lastCelebrationKey) {
      launchConfetti();
      lastCelebrationKey = celebrationKey;
    }
  }

  function applyChallengeToBoard(challenge) {
    currentChallenge = challenge;
    currentUpdatedAt = challenge.updatedAt || currentUpdatedAt;
    if (roundDisplay) {
      roundDisplay.textContent = `Rodada ${Number(challenge.challengeNumber || 1)}`;
    }
    title.textContent = challenge.challengeTitle || "Desafio da rodada";
    prize.textContent = challenge.prize || "-";
    winnerDisplay.textContent = challenge.winner || "Aguardando definicao";
    renderChallengeRankingTable(rankingTable, challenge, currentPhotos);
    renderCelebrationOverlay(challenge);
  }

  async function refreshBoard(force = false) {
    const challenge = await fetchChallenge();
    const shouldRefresh = force || (challenge.updatedAt && challenge.updatedAt !== currentUpdatedAt);

    if (shouldRefresh) {
      applyChallengeToBoard(challenge);
    }

    return challenge;
  }

  async function refreshGallery() {
    const payload = await fetchChallengeSubmissions();
    currentPhotos = payload.photos || [];
    renderChallengeGallery(galleryGrid, currentPhotos);
    if (currentChallenge) {
      renderChallengeRankingTable(rankingTable, currentChallenge, currentPhotos);
    }
  }

  const uploadUrl = `${window.location.origin}/challenge-upload`;
  if (uploadLink) {
    uploadLink.href = uploadUrl;
  }
  if (qrImage) {
    qrImage.src = "/qrcode.png";
    qrImage.width = 490;
    qrImage.height = 490;
    qrImage.addEventListener("error", () => {
      qrImage.alt = `QR indisponivel. Acesse ${uploadUrl}`;
      qrImage.removeAttribute("src");
    }, { once: true });
  }

  openGalleryButton?.addEventListener("click", openGalleryModal);
  closeGalleryButton?.addEventListener("click", closeGalleryModal);
  closeGalleryBackdrop?.addEventListener("click", closeGalleryModal);

  try {
    await refreshBoard(true);
    await refreshGallery();
  } catch (error) {
    title.textContent = "Nao foi possivel carregar o desafio.";
  }

  window.addEventListener("storage", async (event) => {
    if (event.key !== CHALLENGE_SYNC_KEY) return;
    try {
      await refreshBoard(true);
      await refreshGallery();
    } catch {}
  });

  challengeSyncChannel?.addEventListener("message", async () => {
    try {
      await refreshBoard(true);
      await refreshGallery();
    } catch {}
  });

  window.setInterval(async () => {
    try {
      await refreshBoard(false);
      await refreshGallery();
    } catch {}
  }, DEFAULT_CHALLENGE_POLL_INTERVAL_MS);
}

function getCachedGuestName() {
  try {
    return localStorage.getItem(CHALLENGE_NAME_CACHE_KEY) || "";
  } catch {
    return "";
  }
}

function saveCachedGuestName(name) {
  try {
    localStorage.setItem(CHALLENGE_NAME_CACHE_KEY, name);
  } catch {}
}

function formatGuestNameForChallenge(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .toUpperCase();
}

function initUploadPage() {
  const form = document.getElementById("challenge-upload-form");
  const nameInput = document.getElementById("challengeGuestName");
  const photoInput = document.getElementById("challengePhoto");
  const status = document.getElementById("challenge-upload-status");
  const submit = document.getElementById("challenge-upload-submit");
  let currentChallenge = null;

  function setUploadButtonLabel(challenge) {
    if (!submit) return;
    const challengeNumber = challenge?.challengeNumber || 1;
    submit.textContent = `Enviar imagem (Rodada ${challengeNumber})`;
  }

  if (nameInput) {
    nameInput.value = formatGuestNameForChallenge(getCachedGuestName());
    nameInput.addEventListener("input", () => {
      const formattedName = formatGuestNameForChallenge(nameInput.value);
      nameInput.value = formattedName;
      saveCachedGuestName(formattedName);
    });
  }

  form?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const guestName = formatGuestNameForChallenge(nameInput?.value);
    const file = photoInput?.files?.[0];

    if (!guestName || !file) {
      setStatus(status, "Informe seu nome e escolha uma imagem.", "error");
      return;
    }

    saveCachedGuestName(guestName);
    submit.disabled = true;
    setStatus(status, "Enviando imagem...");

    try {
      const formData = new FormData();
      formData.append("guestName", guestName);
      formData.append("photo", file);

      const response = await fetch("/api/challenge-submissions", {
        method: "POST",
        body: formData
      });
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Falha ao enviar imagem.");
      }

      form.reset();
      nameInput.value = guestName;
      setStatus(status, "Imagem enviada com sucesso. Boa sorte no desafio!", "success");
    } catch (error) {
      setStatus(status, error.message || "Falha ao enviar imagem.", "error");
    } finally {
      submit.disabled = false;
    }
  });

  async function checkChallengeStatus() {
    try {
      const challenge = await fetchChallenge();
      currentChallenge = challenge;
      setUploadButtonLabel(challenge);
    } catch {}
  }

  checkChallengeStatus();
  window.setInterval(checkChallengeStatus, UPLOAD_CHALLENGE_POLL_INTERVAL_MS);
}

if (pageMode === "create") {
  initCreatePage();
} else if (pageMode === "board") {
  initBoardPage();
} else if (pageMode === "upload") {
  initUploadPage();
}
