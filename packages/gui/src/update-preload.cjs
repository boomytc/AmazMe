const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("amazmeUpdates", {
	command: (command, value) => ipcRenderer.invoke("amazme:update-command", command, value),
	onState: (listener) => ipcRenderer.on("amazme:update-state", (_event, state, copy) => listener(state, copy)),
});
