import { spawn } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { electronBinary, smokeEnvironment } from "./smoke-support.ts";
import { createTempDir } from "./temp-dir.ts";

const directories: string[] = [];
afterEach(async () => { for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
test.each(["en", "zh"] as const)("update window uses real preload IPC, consent, cancellation, later and duplicate-click guards (%s)", async locale => {
	const directory = createTempDir("amazme-update-window-"); directories.push(directory);
	const evidence = process.env.AMAZME_GUI_UPDATE_EVIDENCE;
	if (evidence) await mkdir(evidence, { recursive: true });
	const fixture = join(directory, "fixture.mjs");
	await writeFile(fixture, [
		'import assert from "node:assert/strict";',
		'import { writeFile } from "node:fs/promises";',
		'import { app, BrowserWindow, dialog } from "electron";',
		"import { createDesktopUpdates } from " + JSON.stringify(new URL("../dist/desktop-updates.js", import.meta.url).href) + ";",
		"const locale = " + JSON.stringify(locale) + ";",
		"app.setPath('userData', " + JSON.stringify(directory) + ");",
		"app.whenReady().then(async () => {",
		"let checks=0, downloads=0, installs=0, prompts=0;",
		"const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));",
		"dialog.showMessageBox=async()=>{prompts++; return {response:1,checkboxChecked:false};};",
		"const updates=createDesktopUpdates({version:'8.5.0', executable:process.execPath,userData:" + JSON.stringify(directory) + ",locale:async()=>locale,confirmQuit:async()=>true,quit:async()=>{},io:{",
		"check:async()=>{checks++; return {manifest:{version:'8.6.0',tag:'v8.6.0',assets:[]},asset:{name:'fixture.dmg',url:'https://github.com/boomytc/AmazMe/releases/download/v8.6.0/fixture.dmg',sha256:'c'.repeat(64),size:100}};},",
		"download:async(_asset,signal,progress)=>{downloads++; progress(25,100); if(downloads===1) await new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('network')),{once:true})); return '/fixture/update.dmg';},",
		"verify:async()=>({directory:'/fixture/prepared'}),discard:async()=>{},install:async()=>{installs++;}}});",
		"try {",
		"await updates.show(); const window=BrowserWindow.getAllWindows()[0]; assert.ok(window);",
		"const read=()=>window.webContents.executeJavaScript(\"({status:document.getElementById('status').textContent,download:!document.getElementById('download').hidden,install:!document.getElementById('install').hidden,cancel:!document.getElementById('cancel').hidden,auto:document.getElementById('automatic').checked,lang:document.documentElement.lang})\");",
		"async function waitFor(check){const end=Date.now()+10000;while(!await check()){if(Date.now()>end)throw new Error('UI state timed out: '+JSON.stringify(await read()));await pause(25);}}",
		"const click=id=>window.webContents.executeJavaScript('document.getElementById('+JSON.stringify(id)+').click()');",
		"await waitFor(async()=> (await read()).lang===locale); assert.equal((await read()).auto,true);",
		"await click('check'); await waitFor(async()=> (await read()).download); assert.equal(downloads,0);",
		"await click('download'); await click('download'); await waitFor(async()=> (await read()).cancel); assert.equal(prompts,1); assert.equal(downloads,1);",
		"await click('cancel'); await waitFor(async()=> (await read()).download); assert.equal(installs,0);",
		"await click('download'); await waitFor(async()=> (await read()).install); assert.equal(downloads,2); assert.equal(installs,0);",
		"await click('later'); assert.equal(window.isVisible(),false); await updates.show(); assert.equal((await read()).install,true);",
		"const intruder=new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,preload:" + JSON.stringify(new URL("../dist/update-preload.cjs", import.meta.url).pathname) + "}});",
		"await intruder.loadURL(" + JSON.stringify(new URL("../dist/update-window.html", import.meta.url).href) + "); await intruder.webContents.executeJavaScript(\"window.amazmeUpdates.command('check')\"); assert.equal(checks,1); intruder.destroy();",
		...(evidence ? ["await writeFile(" + JSON.stringify(join(evidence, "updates-" + locale + ".png")) + ",(await window.webContents.capturePage()).toPNG());"] : []),
		"const ready=await read(); assert.equal(ready.lang,locale);",
		"assert.equal(await window.webContents.executeJavaScript(\"document.getElementById('install').textContent\"),locale==='zh'?'安装并重启':'Install and Restart');",
		"await click('install'); await click('install'); await waitFor(()=>installs===1);",
		"process.stdout.write('update window smoke: '+JSON.stringify({locale,checks,downloads,installs,prompts,ready})+'\\n');",
		"await updates.dispose(); app.exit(0);",
		"} catch(error){ console.error(error); app.exit(1); }",
		"}).catch(error=>{console.error(error);app.exit(1);});",
	].join("\n"));
	const child = spawn(electronBinary(), ["--disable-gpu", fixture], { env: smokeEnvironment(directory), stdio: ["ignore", "pipe", "pipe"] });
	let output = "", errors = "";
	child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { errors = (errors + String(chunk)).slice(-8000); });
	const code = await new Promise<number | null>((resolve, reject) => {
		const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Update window timed out\n" + output + errors)); }, 30_000);
		child.once("error", reject); child.once("exit", value => { clearTimeout(timer); resolve(value); });
	});
	expect(code, output + errors).toBe(0);
	const marker = output.split("\n").find(line => line.startsWith("update window smoke: "));
	expect(marker).toBeDefined();
	expect(JSON.parse(marker!.slice("update window smoke: ".length))).toMatchObject({ locale, checks: 1, downloads: 2, installs: 1, prompts: 2 });
}, 45_000);

test.each([true, false])("ordinary second startup exits without a modal while installer verification holds the lock (smoke=%s)", async smoke => {
	const directory = createTempDir("amazme-update-startup-"); directories.push(directory);
	const executable = electronBinary(), target = dirname(dirname(dirname(executable))), lock = target + ".update-lock";
	const job = createTempDir(".AmazMe-update-", { baseDirectory: dirname(target) });
	const snapshot = { target, nonce: "e".repeat(36), current: "8.5.0", version: "8.6.0", team: "ABCDE12345", arch: "arm64", originalHash: "a".repeat(40), parentPid: process.pid };
	await writeFile(lock, JSON.stringify({ format: 1, target, directory: job, nonce: snapshot.nonce, version: snapshot.current, phase: "preparing", pid: process.pid, job: snapshot }), { mode: 0o600, flag: "wx" });
	try {
		const fixture = join(directory, "locked-startup.mjs");
		await writeFile(fixture, 'import {dialog} from "electron"; dialog.showMessageBox=async()=>{throw new Error("A blocked launch must not show a modal");};\nawait import(' + JSON.stringify(new URL("../dist/main.js", import.meta.url).href) + ");\n");
		const env: NodeJS.ProcessEnv = { ...smokeEnvironment(directory), AMAZME_GUI_USER_DATA_DIR: directory };
		if (!smoke) delete env.AMAZME_GUI_SMOKE;
		const child = spawn(executable, ["--disable-gpu", fixture], { env, stdio: ["ignore", "pipe", "pipe"] });
		let output = "", errors = "";
		child.stdout.on("data", chunk => { output += String(chunk); }); child.stderr.on("data", chunk => { errors += String(chunk); });
		const code = await new Promise<number | null>((resolve, reject) => {
			const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error("Blocked startup timed out\n" + output + errors)); }, 15_000);
			child.once("error", reject); child.once("exit", value => { clearTimeout(timer); resolve(value); });
		});
		expect(code, errors).toBe(0);
		expect(output).toContain("desktop update startup blocked");
		expect(output).not.toContain("desktop host pid:");
	} finally { await rm(lock, { recursive: true, force: true }); }
}, 20_000);
