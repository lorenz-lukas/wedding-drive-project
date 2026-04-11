const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const uploadHandler = require("./api/upload");
const validateGuestHandler = require("./api/validate-guest");
const configHandler = require("./api/config");
const galleryHandler = require("./api/gallery");
const galleryMediaHandler = require("./api/gallery-media");
const loginHandler = require("./api/login");
const downloadHandler = require("./api/download");
const challengeUploadHandler = require("./api/challenge-upload");

function optionalRequire(modulePath) {
  try {
    return require(modulePath);
  } catch (error) {
    if (error && (error.code === "MODULE_NOT_FOUND" || /Cannot find module/i.test(String(error.message || "")))) {
      return null;
    }
    throw error;
  }
}

const challengeHandler = optionalRequire("./api/challenge");
const challengeFinalizeHandler = optionalRequire("./api/challenge-finalize");
const challengeSubmissionsHandler = optionalRequire("./api/challenge-submissions");
const challengeSubmissionMediaHandler = optionalRequire("./api/challenge-submission-media");

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.join(__dirname, "public");
const MEDIA_DIR = path.join(__dirname, "media");
const DISABLE_CHALLENGE_ROUTES = String(process.env.DISABLE_CHALLENGE_ROUTES || "false").trim().toLowerCase() === "true";

const CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mov": "video/quicktime",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml; charset=utf-8",
  ".webp": "image/webp"
};

function enhanceResponse(res) {
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };

  res.json = (payload) => {
    if (!res.headersSent) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    }
    res.end(JSON.stringify(payload));
    return res;
  };

  return res;
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return CONTENT_TYPES[extension] || "application/octet-stream";
}

function resolveStaticFile(urlPath) {
  const decodedPath = decodeURIComponent(urlPath);

  if (decodedPath === "/gallery" || decodedPath === "/gallery/") {
    return path.join(PUBLIC_DIR, "gallery.html");
  }

  if (decodedPath === "/download" || decodedPath === "/download/") {
    return path.join(PUBLIC_DIR, "download.html");
  }

  if (
    !DISABLE_CHALLENGE_ROUTES &&
    (
      decodedPath === "/challenge-board" ||
      decodedPath === "/challenge-board/" ||
      decodedPath === "/challenges" ||
      decodedPath === "/challenges/" ||
      decodedPath === "/desafios" ||
      decodedPath === "/desafios/"
    )
  ) {
    return path.join(PUBLIC_DIR, "challenge-board.html");
  }

  if (
    !DISABLE_CHALLENGE_ROUTES &&
    (
      decodedPath === "/challenge-create" ||
      decodedPath === "/challenge-create/" ||
      decodedPath === "/challenges/create" ||
      decodedPath === "/challenges/create/" ||
      decodedPath === "/desafios/criar" ||
      decodedPath === "/desafios/criar/"
    )
  ) {
    return path.join(PUBLIC_DIR, "challenge-create.html");
  }

  if (
    decodedPath === "/challenge-upload" ||
    decodedPath === "/challenge-upload/" ||
    decodedPath === "/challenges/upload" ||
    decodedPath === "/challenges/upload/" ||
    decodedPath === "/desafios/upload" ||
    decodedPath === "/desafios/upload/"
  ) {
    return path.join(PUBLIC_DIR, "challenge-upload.html");
  }

  if (decodedPath.startsWith("/media/")) {
    const relativePath = path.normalize(decodedPath.slice("/media/".length));
    if (relativePath.startsWith("..")) {
      return null;
    }
    const primaryMediaPath = path.join(MEDIA_DIR, relativePath);
    if (fs.existsSync(primaryMediaPath)) {
      return primaryMediaPath;
    }
    return path.join(PUBLIC_DIR, "media", relativePath);
  }

  const normalizedPath =
    decodedPath === "/" ? "index.html" : path.normalize(decodedPath.replace(/^\//, ""));

  if (normalizedPath.startsWith("..")) {
    return null;
  }

  return path.join(PUBLIC_DIR, normalizedPath);
}

function renderHtmlTemplate(content) {
  const challengePoll = String(
    Math.max(120000, Number(process.env.CHALLENGE_POLL_INTERVAL_MS || 120000))
  );
  const uploadChallengePoll = String(
    Math.max(300000, Number(process.env.CHALLENGE_UPLOAD_POLL_INTERVAL_MS || 300000))
  );

  return content
    .replace(/__CHALLENGE_POLL_INTERVAL_MS__/g, challengePoll)
    .replace(/__CHALLENGE_UPLOAD_POLL_INTERVAL_MS__/g, uploadChallengePoll);
}

function serveStaticFile(filePath, res, method) {
  fs.stat(filePath, (error, stats) => {
    if (error || !stats.isFile()) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Arquivo nao encontrado.");
      return;
    }

    res.statusCode = 200;
    res.setHeader("Content-Type", getContentType(filePath));

    if (method === "HEAD") {
      res.end();
      return;
    }

    if (path.extname(filePath).toLowerCase() === ".html") {
      fs.readFile(filePath, "utf8", (readError, content) => {
        if (readError) {
          if (!res.headersSent) {
            res.statusCode = 500;
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
          }
          res.end("Falha ao ler arquivo.");
          return;
        }

        const rendered = renderHtmlTemplate(content);
        res.setHeader("Content-Length", Buffer.byteLength(rendered, "utf8"));
        res.end(rendered, "utf8");
      });
      return;
    }

    res.setHeader("Content-Length", stats.size);
    const stream = fs.createReadStream(filePath);
    stream.on("error", () => {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
      }
      res.end("Falha ao ler arquivo.");
    });
    stream.pipe(res);
  });
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (requestUrl.pathname === "/api/upload") {
    try {
      await uploadHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/login") {
    try {
      await loginHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/validate-guest") {
    try {
      await validateGuestHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/config") {
    try {
      await configHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/gallery") {
    try {
      await galleryHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/gallery-media") {
    try {
      await galleryMediaHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/download") {
    try {
      await downloadHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (
    DISABLE_CHALLENGE_ROUTES &&
    (
      requestUrl.pathname === "/api/challenges" ||
      requestUrl.pathname === "/api/challenge" ||
      requestUrl.pathname === "/api/challenge-submissions" ||
      requestUrl.pathname === "/api/challenge-submissions-feed" ||
      requestUrl.pathname === "/api/challenge-submission-media" ||
      requestUrl.pathname === "/api/challenges/finalize" ||
      requestUrl.pathname === "/api/challenge-finalize"
    )
  ) {
    enhanceResponse(res).status(404).json({ error: "Challenge desativado temporariamente." });
    return;
  }

  if (requestUrl.pathname === "/api/challenges" || requestUrl.pathname === "/api/challenge") {
    try {
      await challengeHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (
    requestUrl.pathname === "/api/challenge-submissions" ||
    requestUrl.pathname === "/api/challenge-upload"
  ) {
    try {
      await challengeUploadHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/challenge-submissions-feed") {
    try {
      await challengeSubmissionsHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (requestUrl.pathname === "/api/challenge-submission-media") {
    try {
      await challengeSubmissionMediaHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (
    requestUrl.pathname === "/api/challenges/finalize" ||
    requestUrl.pathname === "/api/challenge-finalize"
  ) {
    try {
      await challengeFinalizeHandler(req, enhanceResponse(res));
    } catch (error) {
      enhanceResponse(res)
        .status(500)
        .json({ error: "Falha interna no servidor.", details: error.message });
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD, POST");
    res.end("Metodo nao permitido.");
    return;
  }

  const filePath = resolveStaticFile(requestUrl.pathname);
  if (!filePath) {
    res.statusCode = 400;
    res.end("Caminho invalido.");
    return;
  }

  serveStaticFile(filePath, res, req.method);
});

if (require.main === module) {
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Servidor local em http://0.0.0.0:${PORT}`);
  });
}

module.exports = server;
