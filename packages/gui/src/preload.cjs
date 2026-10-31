const { contextBridge, ipcRenderer } = require("electron");

const MENU_ACTION_CHANNEL = "amazme:menu-action";

contextBridge.exposeInMainWorld("amazmeDesktop", {
	pickDirectories: () => ipcRenderer.invoke("amazme:pick-directories"),
	onMenuAction: (listener) => {
		const handler = (_event, action) => listener(action);
		ipcRenderer.on(MENU_ACTION_CHANNEL, handler);
		return () => ipcRenderer.removeListener(MENU_ACTION_CHANNEL, handler);
	},
});
