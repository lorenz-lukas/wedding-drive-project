const form = document.getElementById("upload-form");
const statusEl = document.getElementById("status");
const submitButton = document.getElementById("submit-button");
const guestNameInput = document.getElementById("guestName");
const guestSummary = document.getElementById("guest-summary");
const slides = Array.from(document.querySelectorAll("[data-slide]"));
const dotsContainer = document.getElementById("slide-dots");
const showUploadButton = document.getElementById("show-upload");
const uploadSection = document.getElementById("upload-section");
const storySection = document.getElementById("story-section");
const maxFilesLabel = document.getElementById("max-files-label");
const maxSizeLabel = document.getElementById("max-size-label");
const guestModalShell = document.getElementById("guest-modal-shell");
const guestModalClose = document.getElementById("guest-modal-close");
const guestValidationForm = document.getElementById("guest-validation-form");
const guestFirstNameInput = document.getElementById("guestFirstName");
const guestLastNameInput = document.getElementById("guestLastName");
const guestValidationStatus = document.getElementById("guest-validation-status");
const guestValidationSubmit = document.getElementById("guest-validation-submit");
const guestValidationCancel = document.getElementById("guest-validation-cancel");
const modalBackdrop = document.querySelector("[data-close-modal]");
const authModalShell = document.getElementById("auth-modal-shell");
const authForm = document.getElementById("auth-form");
const authUsernameInput = document.getElementById("authUsername");
const authPasswordInput = document.getElementById("authPassword");
const authStatus = document.getElementById("auth-status");
const authSubmit = document.getElementById("auth-submit");
const galleryToggleButton = document.getElementById("gallery-toggle-button");

const AUTH_TOKEN_STORAGE_KEY = "casamento_auth_token";
const IS_GALLERY_ROUTE = window.location.pathname.replace(/\/+$/, "") === "/gallery";
const GUEST_COOKIE_FIRST_NAME = "casamento_guest_first_name";
const GUEST_COOKIE_LAST_NAME = "casamento_guest_last_name";
const GUEST_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const DEFAULT_SLIDE_INTERVAL_MS = 2000;
const HAS_UPLOAD_FLOW = Boolean(form && uploadSection);
const DEFAULT_FIRST_SLIDE_DELAY_MS = 5000;
let activeSlideIndex = 0;
let slideTimer = null;
let firstSlideTimeout = null;
let uploadIsVisible = false;
let isUploading = false;
let slideIntervalMs = DEFAULT_SLIDE_INTERVAL_MS;
let firstSlideDelayMs = DEFAULT_FIRST_SLIDE_DELAY_MS;
let authToken = localStorage.getItem(AUTH_TOKEN_STORAGE_KEY) || "";
let appStarted = false;
let gallerySlideshowEnabled = true;
let galleryCycleInFlight = false;
let galleryObjectUrls = [];
let uploadConfig = {
  maxFiles: 10,
  maxSizeMb: 15,
  requestBodyLimitMb: null,
  slideIntervalMs: DEFAULT_SLIDE_INTERVAL_MS,
  firstSlideDelayMs: DEFAULT_FIRST_SLIDE_DELAY_MS
};

if (HAS_UPLOAD_FLOW && uploadSection && !uploadIsVisible) {
  uploadSection.setAttribute("hidden", "hidden");
  uploadSection.classList.add("hidden-upload");
  uploadSection.classList.remove("upload-visible");
}

function setAuthStatus(message, type) {
  if (!authStatus) return;

  authStatus.textContent = message;
  if (type === "success") {
    authStatus.style.color = "#2d6a4f";
    return;
  }
  if (type === "error") {
    authStatus.style.color = "#ab2f2f";
    return;
  }
  authStatus.style.color = "#5e4a48";
}

function openAuthModal() {
  if (!IS_GALLERY_ROUTE) return;
  if (!authModalShell) return;
  authModalShell.classList.remove("hidden");
  authModalShell.setAttribute("aria-hidden", "false");
  setAuthStatus("", "info");
  window.setTimeout(() => {
    if (authUsernameInput) {
      authUsernameInput.focus();
    }
  }, 30);
}

function closeAuthModal() {
  if (!authModalShell) return;
  authModalShell.classList.add("hidden");
  authModalShell.setAttribute("aria-hidden", "true");
  setAuthStatus("", "info");
}

function setAuthToken(token) {
  authToken = token;
  if (token) {
    localStorage.setItem(AUTH_TOKEN_STORAGE_KEY, token);
    return;
  }
  localStorage.removeItem(AUTH_TOKEN_STORAGE_KEY);
}

async function apiFetch(url, options = {}) {
  const headers = new Headers(options.headers || {});

  if (authToken) {
    headers.set("Authorization", `Bearer ${authToken}`);
  }

  const response = await fetch(url, {
    ...options,
    headers
  });

  if (response.status === 401 && IS_GALLERY_ROUTE) {
    setAuthToken("");
    openAuthModal();
  }

  return response;
}

async function readResponsePayload(response) {
  const rawText = await response.text();
  let payload = {};

  try {
    payload = rawText ? JSON.parse(rawText) : {};
  } catch {
    payload = {};
  }

  return {
    rawText,
    payload
  };
}

function getFriendlyUploadResponseError(response, payload, rawText, fallbackMessage) {
  if (payload && payload.error) {
    const details = payload.details ? ` ${payload.details}` : "";
    return `${payload.error}${details}`.trim();
  }

  const contentType = String(response.headers.get("content-type") || "").toLowerCase();
  if (rawText && !contentType.includes("application/json")) {
    return "O servidor de upload retornou uma resposta invalida. Isso normalmente indica falha no deploy ou configuracao ausente na Vercel.";
  }

  return fallbackMessage;
}

function getFileExtensionFromType(mimeType) {
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/webp") return ".webp";
  return ".jpg";
}

function renameFileWithExtension(fileName, extension) {
  const baseName = String(fileName || "arquivo")
    .replace(/\.[a-z0-9]+$/i, "")
    .trim();
  return `${baseName || "arquivo"}${extension}`;
}

function isCompressibleImage(file) {
  return Boolean(
    file &&
    typeof file.type === "string" &&
    /^image\/(jpeg|jpg|png|webp)$/i.test(file.type)
  );
}

function loadImageFromFile(file) {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("Nao foi possivel abrir a imagem para compactacao."));
    };

    image.src = objectUrl;
  });
}

function canvasToBlob(canvas, mimeType, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("Nao foi possivel gerar a imagem compactada."));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
}

async function compressImageFile(file, targetMaxBytes) {
  const image = await loadImageFromFile(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const dimensionScales = [1, 0.85, 0.72, 0.6];
  const qualitySteps = [0.82, 0.74, 0.66, 0.58, 0.5];
  let bestBlob = null;

  for (const dimensionScale of dimensionScales) {
    const width = Math.max(1, Math.round(sourceWidth * dimensionScale));
    const height = Math.max(1, Math.round(sourceHeight * dimensionScale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new Error("Nao foi possivel preparar a compactacao da imagem.");
    }

    context.drawImage(image, 0, 0, width, height);

    for (const quality of qualitySteps) {
      const blob = await canvasToBlob(canvas, "image/jpeg", quality);

      if (!bestBlob || blob.size < bestBlob.size) {
        bestBlob = blob;
      }

      if (blob.size <= targetMaxBytes) {
        return new File(
          [blob],
          renameFileWithExtension(file.name, getFileExtensionFromType(blob.type)),
          {
            type: blob.type,
            lastModified: file.lastModified || Date.now()
          }
        );
      }
    }
  }

  if (!bestBlob) {
    return file;
  }

  return new File(
    [bestBlob],
    renameFileWithExtension(file.name, getFileExtensionFromType(bestBlob.type)),
    {
      type: bestBlob.type,
      lastModified: file.lastModified || Date.now()
    }
  );
}

function getTotalFilesSize(files) {
  let totalSizeBytes = 0;

  for (const file of files) {
    totalSizeBytes += file.size;
  }

  return totalSizeBytes;
}

async function prepareFilesForUpload(fileList) {
  const originalFiles = Array.from(fileList || []);
  const perFileLimitBytes = uploadConfig.maxSizeMb * 1024 * 1024;
  const totalLimitBytes = uploadConfig.requestBodyLimitMb
    ? uploadConfig.requestBodyLimitMb * 1024 * 1024
    : null;
  const compressibleCount = originalFiles.filter(isCompressibleImage).length;

  if (compressibleCount === 0) {
    return originalFiles;
  }

  const totalSizeBytes = getTotalFilesSize(originalFiles);
  const needsCompression = originalFiles.some((file) => (
    isCompressibleImage(file) && (
      file.size > perFileLimitBytes ||
      (totalLimitBytes && totalSizeBytes > totalLimitBytes)
    )
  ));

  if (!needsCompression) {
    return originalFiles;
  }

  const sharedImageBudgetBytes = totalLimitBytes
    ? Math.max(900 * 1024, Math.floor(totalLimitBytes / Math.max(compressibleCount, 1)))
    : perFileLimitBytes;
  const targetMaxBytes = totalLimitBytes
    ? Math.min(perFileLimitBytes, sharedImageBudgetBytes)
    : perFileLimitBytes;
  const preparedFiles = [];

  setStatus("Preparando fotos para envio...", "info");

  for (const file of originalFiles) {
    if (!isCompressibleImage(file)) {
      preparedFiles.push(file);
      continue;
    }

    if (file.size <= targetMaxBytes && (!totalLimitBytes || totalSizeBytes <= totalLimitBytes)) {
      preparedFiles.push(file);
      continue;
    }

    try {
      preparedFiles.push(await compressImageFile(file, targetMaxBytes));
    } catch {
      preparedFiles.push(file);
    }
  }

  return preparedFiles;
}

function revokeGalleryObjectUrls() {
  galleryObjectUrls.forEach((url) => URL.revokeObjectURL(url));
  galleryObjectUrls = [];
}

async function loadProtectedImageUrl(mediaToken) {
  const response = await apiFetch("/api/gallery-media", {
    method: "POST",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: mediaToken })
  });
  if (!response.ok) {
    throw new Error("Falha ao carregar imagem protegida.");
  }

  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  galleryObjectUrls.push(objectUrl);
  return objectUrl;
}

async function startAppAfterAuth() {
  if (appStarted) {
    return;
  }

  if (IS_GALLERY_ROUTE && !authToken) {
    return;
  }

  const configLoaded = await loadUploadConfig();
  if (!configLoaded) {
    return;
  }

  if (IS_GALLERY_ROUTE) {
    if (!authToken) {
      return;
    }

    appStarted = true;
    closeAuthModal();
    updateGalleryToggleButton();
    await runGalleryCycle();
    return;
  }

  appStarted = true;
  closeAuthModal();
  startSlideshow();
}

async function loadGallerySlides() {
  if (!IS_GALLERY_ROUTE || !authToken) {
    return false;
  }

  try {
    const response = await apiFetch("/api/gallery");
    if (response.status === 401) {
      return false;
    }

    const payload = await response.json();

    if (!response.ok || !Array.isArray(payload.photos) || payload.photos.length === 0) {
      return false;
    }

    const slideshow = document.getElementById("slideshow");
    if (!slideshow) {
      return false;
    }

    revokeGalleryObjectUrls();

    const mappedSlides = await Promise.all(payload.photos.map(async (photo, index) => {
      if (!photo || !photo.mediaToken) {
        return null;
      }

      const article = document.createElement("article");
      article.className = `slide${index === 0 ? " is-active" : ""}`;
      article.setAttribute("data-slide", "");

      const image = document.createElement("img");
      image.src = await loadProtectedImageUrl(photo.mediaToken);
      image.alt = photo.alt || "Foto do casamento";

      article.appendChild(image);

      const captionText = typeof photo.caption === "string" ? photo.caption.trim() : "";
      if (captionText) {
        const caption = document.createElement("p");
        caption.textContent = captionText;
        article.appendChild(caption);
      }

      return article;
    }));

    const validSlides = mappedSlides.filter(Boolean);
    if (validSlides.length === 0) {
      return false;
    }

    slideshow.innerHTML = "";
    for (const node of validSlides) {
      slideshow.appendChild(node);
    }

    slides.length = 0;
    slides.push(...slideshow.querySelectorAll("[data-slide]"));
    activeSlideIndex = 0;
    return true;
  } catch {
    // Mantem slides locais como fallback.
    return true;
  }
}

function applyUploadConfig(config) {
  const maxFiles = Number(config.maxFiles) || 10;
  const maxSizeMb = Number(config.maxSizeMb) || 15;
  const requestBodyLimitMb = config.requestBodyLimitMb
    ? Number(config.requestBodyLimitMb) || null
    : null;
  const slideInterval = Number(config.slideIntervalMs) || DEFAULT_SLIDE_INTERVAL_MS;
  const firstSlideDelay = Number(config.firstSlideDelayMs) || DEFAULT_FIRST_SLIDE_DELAY_MS;

  uploadConfig = {
    maxFiles,
    maxSizeMb,
    requestBodyLimitMb,
    slideIntervalMs: slideInterval,
    firstSlideDelayMs: firstSlideDelay
  };

  slideIntervalMs = Math.max(600, slideInterval);
  firstSlideDelayMs = Math.max(0, firstSlideDelay);

  if (maxFilesLabel) {
    maxFilesLabel.textContent = String(maxFiles);
  }

  if (maxSizeLabel) {
    maxSizeLabel.textContent = `${maxSizeMb} MB`;
  }

}

async function loadUploadConfig() {
  try {
    const response = await apiFetch("/api/config");
    if (response.status === 401 && IS_GALLERY_ROUTE) {
      return false;
    }

    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || "Falha ao carregar configuracao.");
    }

    applyUploadConfig(payload);
    return true;
  } catch {
    applyUploadConfig(uploadConfig);
    return true;
  }
}

function clearSlideshowTimers() {
  if (slideTimer) {
    clearInterval(slideTimer);
    slideTimer = null;
  }

  if (firstSlideTimeout) {
    clearTimeout(firstSlideTimeout);
    firstSlideTimeout = null;
  }
}

function updateGalleryToggleButton() {
  if (!galleryToggleButton) {
    return;
  }

  galleryToggleButton.textContent = gallerySlideshowEnabled ? "Pausar" : "Iniciar";
  galleryToggleButton.setAttribute("aria-pressed", gallerySlideshowEnabled ? "true" : "false");
}

async function runGalleryCycle() {
  if (!IS_GALLERY_ROUTE || !gallerySlideshowEnabled || galleryCycleInFlight) {
    return;
  }

  galleryCycleInFlight = true;

  try {
    await loadGallerySlides();
    activeSlideIndex = 0;

    if (gallerySlideshowEnabled) {
      startSlideshow();
    }
  } finally {
    galleryCycleInFlight = false;
  }
}

function createDots() {
  if (!dotsContainer) return;
  dotsContainer.innerHTML = "";
  for (let index = 0; index < slides.length; index += 1) {
    const dot = document.createElement("span");
    dot.className = "slide-dot";
    if (index === activeSlideIndex) {
      dot.classList.add("is-active");
    }
    dotsContainer.appendChild(dot);
  }
}

function updateDots(index) {
  if (!dotsContainer) return;
  const dots = dotsContainer.querySelectorAll(".slide-dot");
  dots.forEach((dot, dotIndex) => {
    dot.classList.toggle("is-active", dotIndex === index);
  });
}

function renderActiveSlide(index) {
  slides.forEach((slide, slideIndex) => {
    slide.classList.toggle("is-active", slideIndex === index);
  });
  updateDots(index);
}

function revealUploadSection() {
  if (!uploadSection || uploadIsVisible) return;

  uploadIsVisible = true;
  uploadSection.removeAttribute("hidden");
  uploadSection.classList.remove("hidden-upload");
  uploadSection.classList.add("upload-visible");

  setTimeout(() => {
    uploadSection.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 240);
}

function closeStorySection() {
  if (!storySection || storySection.classList.contains("story-hidden")) {
    return;
  }

  storySection.classList.add("story-closing");
  window.setTimeout(() => {
    storySection.classList.add("story-hidden");
    storySection.setAttribute("aria-hidden", "true");
    revealUploadSection();
  }, 460);
}

function startSlideshow() {
  if (slides.length === 0) {
    if (HAS_UPLOAD_FLOW) {
      revealUploadSection();
    }
    return;
  }

  clearSlideshowTimers();
  createDots();
  renderActiveSlide(activeSlideIndex);

  firstSlideTimeout = setTimeout(() => {
    slideTimer = setInterval(() => {
      activeSlideIndex += 1;

      if (activeSlideIndex >= slides.length) {
        if (!HAS_UPLOAD_FLOW) {
          clearSlideshowTimers();
          runGalleryCycle();
          return;
        }

        clearSlideshowTimers();
        activeSlideIndex = slides.length - 1;
        renderActiveSlide(activeSlideIndex);
        window.setTimeout(() => {
          closeStorySection();
        }, slideIntervalMs);
        return;
      }

      renderActiveSlide(activeSlideIndex);
    }, slideIntervalMs);
  }, firstSlideDelayMs);
}

if (showUploadButton) {
  showUploadButton.addEventListener("click", () => {
    clearSlideshowTimers();
    closeStorySection();
  });
}

if (galleryToggleButton) {
  galleryToggleButton.addEventListener("click", async () => {
    gallerySlideshowEnabled = !gallerySlideshowEnabled;
    updateGalleryToggleButton();

    if (!gallerySlideshowEnabled) {
      clearSlideshowTimers();
      return;
    }

    await runGalleryCycle();
  });
}

if (!IS_GALLERY_ROUTE) {
  if (authModalShell) {
    authModalShell.classList.add("hidden");
    authModalShell.setAttribute("aria-hidden", "true");
  }
  applyPersistedGuest();
  startAppAfterAuth();
} else if (authToken) {
  startAppAfterAuth();
} else {
  openAuthModal();
}

function setStatus(message, type) {
  if (!statusEl) return;
  statusEl.textContent = message;
  if (type === "success") {
    statusEl.style.color = "#2d6a4f";
    return;
  }
  if (type === "error") {
    statusEl.style.color = "#ab2f2f";
    return;
  }
  statusEl.style.color = "#5e4a48";
}

function setGuestValidationStatus(message, type) {
  if (!guestValidationStatus) return;
  guestValidationStatus.textContent = message;
  if (type === "success") {
    guestValidationStatus.style.color = "#2d6a4f";
    return;
  }
  if (type === "error") {
    guestValidationStatus.style.color = "#ab2f2f";
    return;
  }
  guestValidationStatus.style.color = "#5e4a48";
}

function openGuestModal() {
  if (!guestModalShell || !guestFirstNameInput) return;
  guestModalShell.classList.remove("hidden");
  guestModalShell.setAttribute("aria-hidden", "false");
  setGuestValidationStatus("", "info");
  window.setTimeout(() => {
    guestFirstNameInput.focus();
  }, 30);
}

function closeGuestModal() {
  if (!guestModalShell) return;
  guestModalShell.classList.add("hidden");
  guestModalShell.setAttribute("aria-hidden", "true");
  setGuestValidationStatus("", "info");
}

function setCookie(name, value, maxAgeSeconds) {
  document.cookie = `${name}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax`;
}

function getCookie(name) {
  const encodedName = `${name}=`;
  const parts = document.cookie.split(";");

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (part.startsWith(encodedName)) {
      return decodeURIComponent(part.slice(encodedName.length));
    }
  }

  return "";
}

function persistValidatedGuest(firstName, lastName) {
  setCookie(GUEST_COOKIE_FIRST_NAME, firstName, GUEST_COOKIE_MAX_AGE_SECONDS);
  setCookie(GUEST_COOKIE_LAST_NAME, lastName, GUEST_COOKIE_MAX_AGE_SECONDS);
}

function readPersistedGuest() {
  const firstName = getCookie(GUEST_COOKIE_FIRST_NAME).trim();
  const lastName = getCookie(GUEST_COOKIE_LAST_NAME).trim();

  if (!firstName || !lastName) {
    return null;
  }

  return {
    firstName,
    lastName,
    fullName: `${firstName} ${lastName}`.trim()
  };
}

function applyPersistedGuest() {
  const persistedGuest = readPersistedGuest();
  if (!persistedGuest) {
    return;
  }

  setValidatedGuest(persistedGuest.fullName);

  if (guestFirstNameInput) {
    guestFirstNameInput.value = persistedGuest.firstName;
  }

  if (guestLastNameInput) {
    guestLastNameInput.value = persistedGuest.lastName;
  }
}

function setValidatedGuest(guestName) {
  if (!guestNameInput) {
    return;
  }

  guestNameInput.value = guestName;
  if (guestSummary) {
    guestSummary.textContent = guestName;
    guestSummary.classList.remove("is-empty");
  }
}

async function uploadFiles(preparedFilesOverride) {
  const filesInput = document.getElementById("photos");
  if (!form || !submitButton || !filesInput) {
    return;
  }

  isUploading = true;
  submitButton.disabled = true;
  setStatus("Enviando arquivos...", "info");

  const preparedFiles = preparedFilesOverride || await prepareFilesForUpload(filesInput.files);
  const formData = new FormData();
  formData.append("guestName", guestNameInput ? guestNameInput.value.trim() : "");

  for (const file of preparedFiles) {
    formData.append("photos", file, file.name);
  }

  try {
    const response = await apiFetch("/api/upload", {
      method: "POST",
      body: formData
    });

    const { rawText, payload } = await readResponsePayload(response);

    if (!response.ok) {
      throw new Error(
        getFriendlyUploadResponseError(
          response,
          payload,
          rawText,
          "Falha ao enviar fotos."
        )
      );
    }

    form.reset();
    applyPersistedGuest();
    if (guestValidationForm) {
      guestValidationForm.reset();
    }
    const folderName = payload.guestFolder ? payload.guestFolder.name : "";
    const successMessage = folderName
      ? `Arquivos enviados com sucesso para a pasta ${folderName}. Obrigado por compartilhar esse momento!`
      : "Arquivos enviados com sucesso. Obrigado por compartilhar esse momento!";
    setStatus(successMessage, "success");
  } catch (error) {
    setStatus(error.message || "Nao foi possivel concluir o envio.", "error");
  } finally {
    isUploading = false;
    submitButton.disabled = false;
  }
}

if (form) {
  form.addEventListener("submit", async (event) => {
    event.preventDefault();

    const filesInput = document.getElementById("photos");

    if (!filesInput || !filesInput.files || filesInput.files.length === 0) {
      setStatus("Selecione ao menos um arquivo para enviar.", "error");
      return;
    }

    if (filesInput.files.length > uploadConfig.maxFiles) {
      setStatus(`Envie no maximo ${uploadConfig.maxFiles} arquivos por vez.`, "error");
      return;
    }

    const preparedFiles = await prepareFilesForUpload(filesInput.files);
    const maxFileSizeBytes = uploadConfig.maxSizeMb * 1024 * 1024;
    for (const file of preparedFiles) {
      if (file.size > maxFileSizeBytes) {
        setStatus(
          isCompressibleImage(file)
            ? `Nao foi possivel reduzir a foto o suficiente. O limite final por arquivo e ${uploadConfig.maxSizeMb} MB.`
            : `Cada arquivo deve ter no maximo ${uploadConfig.maxSizeMb} MB. Fotos sao compactadas automaticamente, mas videos e formatos sem compactacao precisam respeitar esse limite.`,
          "error"
        );
        return;
      }
    }

    if (uploadConfig.requestBodyLimitMb) {
      const totalSizeBytes = getTotalFilesSize(preparedFiles);

      if (totalSizeBytes > uploadConfig.requestBodyLimitMb * 1024 * 1024) {
        setStatus(
          `Mesmo apos a compactacao, o total do envio precisa ficar em ate ${uploadConfig.requestBodyLimitMb} MB. Envie menos arquivos por vez.`,
          "error"
        );
        return;
      }
    }

    if (isUploading) {
      return;
    }

    const persistedGuest = readPersistedGuest();
    if (persistedGuest) {
      setValidatedGuest(persistedGuest.fullName);
      setStatus(`Enviando como ${persistedGuest.fullName}...`, "info");
      await uploadFiles(preparedFiles);
      return;
    }

    setStatus("Confirme seu nome na lista para liberar o envio.", "info");
    openGuestModal();
  });
}

if (guestValidationForm && guestFirstNameInput && guestLastNameInput) {
  guestValidationForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const guestName = `${guestFirstNameInput.value.trim()} ${guestLastNameInput.value.trim()}`.trim();

    if (!guestFirstNameInput.value.trim() || !guestLastNameInput.value.trim()) {
      setGuestValidationStatus("Informe nome e sobrenome.", "error");
      return;
    }

    if (guestValidationSubmit) {
      guestValidationSubmit.disabled = true;
    }
    if (guestValidationCancel) {
      guestValidationCancel.disabled = true;
    }
    setGuestValidationStatus("Validando seu nome na lista de convidados...", "info");

    try {
      const response = await apiFetch("/api/validate-guest", {
        headers: {
          "Content-Type": "application/json"
        },
        method: "POST",
        body: JSON.stringify({ guestName })
      });

      const { rawText, payload } = await readResponsePayload(response);

      if (!response.ok) {
        throw new Error(
          getFriendlyUploadResponseError(
            response,
            payload,
            rawText,
            "Nao foi possivel validar seu nome."
          )
        );
      }

      setValidatedGuest(payload.guestName);
      persistValidatedGuest(guestFirstNameInput.value.trim(), guestLastNameInput.value.trim());
      setGuestValidationStatus("Nome confirmado. Iniciando envio...", "success");
      closeGuestModal();
      await uploadFiles();
    } catch (error) {
      setGuestValidationStatus(error.message || "Nao foi possivel validar seu nome.", "error");
    } finally {
      if (guestValidationSubmit) {
        guestValidationSubmit.disabled = false;
      }
      if (guestValidationCancel) {
        guestValidationCancel.disabled = false;
      }
    }
  });
}

if (guestModalClose) {
  guestModalClose.addEventListener("click", closeGuestModal);
}
if (guestValidationCancel) {
  guestValidationCancel.addEventListener("click", closeGuestModal);
}
if (modalBackdrop) {
  modalBackdrop.addEventListener("click", closeGuestModal);
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && guestModalShell && !guestModalShell.classList.contains("hidden")) {
    closeGuestModal();
  }
});

if (authForm) {
  authForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const username = authUsernameInput ? authUsernameInput.value.trim() : "";
    const password = authPasswordInput ? authPasswordInput.value : "";

    if (!username || !password) {
      setAuthStatus("Informe usuario e senha.", "error");
      return;
    }

    authSubmit.disabled = true;
    setAuthStatus("Validando acesso...", "info");

    try {
      const response = await fetch("/api/login", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ username, password })
      });

      const { rawText, payload } = await readResponsePayload(response);

      if (!response.ok || !payload.token) {
        throw new Error(
          getFriendlyUploadResponseError(
            response,
            payload,
            rawText,
            "Falha no login."
          )
        );
      }

      setAuthToken(payload.token);
      setAuthStatus("Acesso autorizado.", "success");
      await startAppAfterAuth();
    } catch (error) {
      setAuthStatus(error.message || "Nao foi possivel autenticar.", "error");
    } finally {
      authSubmit.disabled = false;
    }
  });
}
