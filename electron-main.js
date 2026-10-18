"use strict";

const { app, BrowserWindow, shell } = require("electron");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");

const APP_ROOT = __dirname;
const CONFIG_PATH = () => path.join(app.getPath("userData"), "settings.json");
const STATIC_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".ico": "image/x-icon"
};
const STATIC_FILES = new Set(["/index.html", "/app.js", "/styles.css"]);

let apiBaseUrl = "";
let localOrigin = "";
let localServer;

function errorResponse(response, status, message) {
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  });
  response.end(JSON.stringify({ message }));
}

function validApiBase(value) {
  if (typeof value !== "string" || value.length > 240) return null;
  try {
    const parsed = new URL(value.trim());
    const isLocal = ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname);
    if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLocal)) ||
        parsed.username || parsed.password || parsed.search || parsed.hash ||
        (parsed.pathname !== "/" && parsed.pathname !== "")) return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

async function readSettings() {
  try {
    const saved = JSON.parse(await fs.readFile(CONFIG_PATH(), "utf8"));
    const validated = validApiBase(saved.apiBaseUrl);
    if (!validated) throw new Error("Saved server address is invalid.");
    apiBaseUrl = validated;
  } catch (error) {
    if (error.code !== "ENOENT") console.error("Unable to read VANTA Team Desk settings:", error);
    apiBaseUrl = "";
  }
}

async function writeSettings(baseUrl) {
  const validated = validApiBase(baseUrl);
  if (!validated) {
    throw new Error("Use a valid HTTPS server address. HTTP is only allowed for localhost.");
  }
  const configPath = CONFIG_PATH();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const temporaryPath = `${configPath}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify({ apiBaseUrl: validated }, null, 2), { mode: 0o600 });
    await fs.rename(temporaryPath, configPath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(cleanupError => {
      console.error("Unable to remove an incomplete settings file:", cleanupError);
    });
    throw error;
  }
  apiBaseUrl = validated;
}

function checkLocalOrigin(request) {
  if (!request.headers.origin || request.headers.origin !== localOrigin) {
    return false;
  }
  return request.headers.host === new URL(localOrigin).host;
}

async function readRequestBody(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 1024 * 1024) throw new Error("Request body is too large.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function localizeCookies(upstreamHeaders) {
  const cookies = typeof upstreamHeaders.getSetCookie === "function"
    ? upstreamHeaders.getSetCookie()
    : [];
  return cookies.map(cookie => cookie
    .replace(/;\s*Domain=[^;]*/ig, "")
    .replace(/;\s*Secure/ig, ""));
}

async function proxyApi(request, response) {
  if (!apiBaseUrl) {
    errorResponse(response, 503, "Connect to your team's VANTA server to sign in.");
    return;
  }
  const method = request.method.toUpperCase();
  if (!["GET", "POST", "PUT", "DELETE"].includes(method)) {
    errorResponse(response, 405, "That request method is not supported.");
    return;
  }
  if (!["GET", "HEAD"].includes(method) && !checkLocalOrigin(request)) {
    errorResponse(response, 403, "The request origin could not be verified.");
    return;
  }
  let body;
  try {
    if (!["GET", "HEAD"].includes(method)) body = await readRequestBody(request);
  } catch (error) {
    errorResponse(response, 413, error.message);
    return;
  }

  const requestUrl = new URL(request.url, apiBaseUrl);
  if (requestUrl.origin !== apiBaseUrl || !requestUrl.pathname.startsWith("/api/")) {
    errorResponse(response, 400, "Invalid API request path.");
    return;
  }
  const headers = new Headers();
  const contentType = request.headers["content-type"];
  if (contentType) headers.set("Content-Type", contentType);
  if (request.headers.cookie) headers.set("Cookie", request.headers.cookie);
  headers.set("Origin", apiBaseUrl);

  let upstream;
  try {
    upstream = await fetch(requestUrl, {
      method,
      headers,
      body: body?.length ? body : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
  } catch (error) {
    console.error("Team server request failed:", error);
    errorResponse(response, 502, "Couldn't reach the configured team server. Check its address and connection.");
    return;
  }

  const responseHeaders = {
    "Cache-Control": "no-store",
    "Content-Type": upstream.headers.get("content-type") || "application/json; charset=utf-8",
    "X-Content-Type-Options": "nosniff"
  };
  const cookies = localizeCookies(upstream.headers);
  if (cookies.length) responseHeaders["Set-Cookie"] = cookies;
  const responseBody = Buffer.from(await upstream.arrayBuffer());
  response.writeHead(upstream.status, responseHeaders);
  response.end(responseBody);
}

async function serveStatic(request, response) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url, localOrigin).pathname);
  } catch {
    errorResponse(response, 400, "Invalid app path.");
    return;
  }
  const requestedPath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.resolve(APP_ROOT, `.${requestedPath}`);
  if (!STATIC_FILES.has(requestedPath) || !filePath.startsWith(`${APP_ROOT}${path.sep}`)) {
    errorResponse(response, 404, "File not found.");
    return;
  }
  const contentType = STATIC_TYPES[path.extname(filePath).toLowerCase()];
  if (!contentType) {
    errorResponse(response, 404, "File not found.");
    return;
  }
  try {
    const contents = await fs.readFile(filePath);
    response.writeHead(200, {
      "Cache-Control": "no-cache",
      "Content-Security-Policy": "default-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY"
    });
    response.end(contents);
  } catch (error) {
    if (error.code === "ENOENT") return errorResponse(response, 404, "File not found.");
    console.error("Unable to read desktop app file:", error);
    errorResponse(response, 500, "The app file could not be read.");
  }
}

async function handleRequest(request, response) {
  if (request.url === "/api/app-config" && request.method === "GET") {
    response.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8"
    });
    response.end(JSON.stringify({ configured: Boolean(apiBaseUrl), apiBaseUrl, desktop: true }));
    return;
  }

  if (request.url === "/api/app-config" && request.method === "PUT") {
    if (!checkLocalOrigin(request)) return errorResponse(response, 403, "The request origin could not be verified.");
    try {
      const rawBody = await readRequestBody(request);
      const data = JSON.parse(rawBody.toString("utf8"));
      await writeSettings(data.apiBaseUrl);
      response.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Type": "application/json; charset=utf-8",
        "Set-Cookie": "vanta.teamdesk=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0"
      });
      response.end(JSON.stringify({ configured: true, apiBaseUrl, desktop: true }));
    } catch (error) {
      const isBadInput = error instanceof SyntaxError || error.message.startsWith("Use a valid HTTPS");
      errorResponse(response, isBadInput ? 400 : 500,
        isBadInput ? error.message : "The team server address could not be saved.");
    }
    return;
  }

  if (new URL(request.url, localOrigin).pathname.startsWith("/api/")) {
    if (request.url.startsWith("/api/app-config")) return errorResponse(response, 404, "App setting not found.");
    await proxyApi(request, response);
    return;
  }
  if (request.method !== "GET" && request.method !== "HEAD") return errorResponse(response, 405, "Method not allowed.");
  await serveStatic(request, response);
}

async function startLocalServer() {
  localServer = http.createServer((request, response) => {
    handleRequest(request, response).catch(error => {
      console.error("Desktop app request failed:", error);
      if (!response.headersSent) errorResponse(response, 500, "The desktop app couldn't complete that request.");
      else response.destroy(error);
    });
  });
  await new Promise((resolve, reject) => {
    localServer.once("error", reject);
    localServer.listen(0, "127.0.0.1", resolve);
  });
  const address = localServer.address();
  localOrigin = `http://127.0.0.1:${address.port}`;
}

async function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 780,
    minHeight: 620,
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://")) shell.openExternal(url);
    return { action: "deny" };
  });
  await window.loadURL(localOrigin);
}

const hasAppLock = app.requestSingleInstanceLock();
if (!hasAppLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });

  app.whenReady().then(async () => {
    await readSettings();
    await startLocalServer();
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  }).catch(error => {
    console.error("Unable to start VANTA Team Desk:", error);
    app.quit();
  });

  app.on("before-quit", () => {
    if (localServer) localServer.close();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
