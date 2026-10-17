const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("amazmeDesktop", {
	pickDirectories: () => ipcRenderer.invoke("amazme:pick-directories"),
	onMenuAction: (listener) => {
		ipcRenderer.on("amazme:menu-action", (_event, action) => listener(action));
	},
});
