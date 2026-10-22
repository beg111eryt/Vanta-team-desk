"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("vantaDesktop", {
  openExternal: url => ipcRenderer.invoke("open-external", url),
  onAuthCallback: callback => {
    const listener = (_event, value) => callback(value);
    ipcRenderer.on("auth-callback", listener);
    return () => ipcRenderer.removeListener("auth-callback", listener);
  }
});
