"use strict";

const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

const PROTOCOL = "vantateamdesk:";
let mainWindow;
let pendingAuthUrl = null;

function isAuthCallback(value) {
  try {
    const url = new URL(value);
    return url.protocol === PROTOCOL && url.hostname === "auth" && url.pathname === "/callback";
  } catch {
    return false;
  }
}

function handleAuthCallback(value) {
  if (!isAuthCallback(value)) return;
  pendingAuthUrl = value;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("auth-callback", value);
    pendingAuthUrl = null;
    mainWindow.show();
    mainWindow.focus();
  }
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 780,
    minHeight: 620,
    backgroundColor: "#111318",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "electron-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const appFileUrl = pathToFileURL(path.join(__dirname, "index.html")).href;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const target = new URL(url);
      if (target.protocol === "https:") {
        shell.openExternal(target.toString()).catch(error => console.error("Unable to open external link.", error));
      }
    } catch (error) {
      console.error("Unable to open external link.", error);
    }
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (url !== appFileUrl && !url.startsWith(`${appFileUrl}#`)) event.preventDefault();
  });
  await mainWindow.loadFile(path.join(__dirname, "index.html"));
  if (pendingAuthUrl) handleAuthCallback(pendingAuthUrl);
}

function showStartupError(error) {
  console.error("Unable to start VANTA Team Desk:", error);
  dialog.showErrorBox("VANTA Team Desk could not start", error.message);
  app.quit();
}

const hasAppLock = app.requestSingleInstanceLock();
if (!hasAppLock) {
  app.quit();
} else {
  if (app.isPackaged) {
    app.setAsDefaultProtocolClient("vantateamdesk");
  } else if (process.argv[1]) {
    app.setAsDefaultProtocolClient("vantateamdesk", process.execPath, [path.resolve(process.argv[1])]);
  }
  app.on("second-instance", (_event, commandLine) => {
    const authUrl = commandLine.find(isAuthCallback);
    if (authUrl) handleAuthCallback(authUrl);
    const [window] = BrowserWindow.getAllWindows();
    if (window) {
      if (window.isMinimized()) window.restore();
      window.focus();
    }
  });
  app.on("open-url", (event, url) => {
    event.preventDefault();
    handleAuthCallback(url);
  });
  ipcMain.handle("open-external", async (_event, value) => {
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("Only a valid HTTPS link can be opened.");
    }
    if (url.protocol !== "https:") throw new Error("Only HTTPS links can be opened.");
    await shell.openExternal(url.toString());
  });

  app.whenReady().then(async () => {
    const authUrl = process.argv.find(isAuthCallback);
    if (authUrl) pendingAuthUrl = authUrl;
    await createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(showStartupError);
    });
  }).catch(showStartupError);

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
