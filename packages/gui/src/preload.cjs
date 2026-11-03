const { contextBridge, ipcRenderer } = require("electron");

const MENU_ACTION_CHANNEL = "amazme:menu-action";
const WINDOW_BACKGROUND_CHANNEL = "amazme:set-window-background";

contextBridge.exposeInMainWorld("amazmeDesktop", {
	platform: process.platform,
	pickDirectories: () => ipcRenderer.invoke("amazme:pick-directories"),
	onMenuAction: (listener) => {
		const handler = (_event, action) => listener(action);
		ipcRenderer.on(MENU_ACTION_CHANNEL, handler);
		return () => ipcRenderer.removeListener(MENU_ACTION_CHANNEL, handler);
	},
	setWindowBackground: (color) => {
		ipcRenderer.send(WINDOW_BACKGROUND_CHANNEL, color);
	},
});
