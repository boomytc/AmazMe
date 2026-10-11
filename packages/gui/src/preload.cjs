const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("amazmeDesktop", {
	pickDirectories: () => ipcRenderer.invoke("amazme:pick-directories"),
});
