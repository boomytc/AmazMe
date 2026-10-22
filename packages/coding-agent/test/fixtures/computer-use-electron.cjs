const { app, BrowserWindow } = require("electron");
const { writeFileSync } = require("node:fs");
const argument = (name) => process.argv[process.argv.indexOf(name) + 1];
app.setPath("userData", argument("--fixture-profile"));
app.setName("AmazMe Fixture");
app.whenReady().then(async () => {
	const window = new BrowserWindow({
		width: 820,
		height: 680,
		show: false,
		webPreferences: { nodeIntegration: false, contextIsolation: true },
	});
	await window.loadURL(argument("--fixture-url"));
	window.showInactive();
	writeFileSync(argument("--fixture-pid"), String(process.pid));
});
app.on("window-all-closed", () => app.quit());
