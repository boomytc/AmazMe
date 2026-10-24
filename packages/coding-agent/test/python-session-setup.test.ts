import { afterEach, expect, test, vi } from "vitest";
import { HostClient } from "../src/python-headless.ts";

const session = "a".repeat(32);
const reply = (body: unknown) => new Response(JSON.stringify(body));
afterEach(() => vi.unstubAllGlobals());

test("the window link names the authenticated host, newly created session and selected workspace", async () => {
	let created = "";
	const calls: string[] = [];
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		calls.push(`${init?.method} ${new URL(url).pathname}`);
		if (url.endsWith("/bootstrap")) return reply({build_id:"build", host_epoch:1, profile_id:"host"});
		if (url.endsWith("/sessions") && init?.method === "POST") {
			const body: {session_id:string} = JSON.parse(String(init.body));
			created = body.session_id;
			return reply({session_id:created, workspace:"docs"});
		}
		if (url.endsWith("/sessions")) return reply({sessions:[{session_id:created, workspace:"docs"}]});
		if (init?.method === "DELETE") return reply({});
		if (url.endsWith("/attachments")) return reply({attachment_id:"binding"});
		throw new Error(url);
	}));
	const client = new HostClient("http://host:1234", "private");
	await client.bootstrap();
	const url = new URL(await client.windowUrl("docs"));
	expect(Object.fromEntries(url.searchParams)).toEqual({host:"host",session:created,workspace:"docs"});
	expect(calls.at(-1)).toBe(`DELETE /api/v1/sessions/${created}/attachments/binding`);
	expect(url.href).not.toContain("private");
});

test("a lost plugin load keeps the session/path identity; re-entry queries the original unknown load", async () => {
	let loaded: Record<string, unknown> | undefined;
	let writes = 0;
	vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
		if (url.endsWith("/bootstrap")) return reply({build_id:"build",host_epoch:2});
		if (url.includes("/plugins?")) return reply({plugins:loaded ? [loaded] : []});
		if (url.endsWith("/plugins")) {
			writes++;
			loaded = {...JSON.parse(String(init?.body)), phase:"unknown"} as Record<string, unknown>;
			throw new TypeError("lost receipt");
		}
		throw new Error(url);
	}));
	const client = new HostClient("http://host", "private");
	await client.bootstrap();
	await expect(client.loadExtensions(session,["/tools/helper.py"])).rejects.toThrow(`plugin_load_unconfirmed session=${session}`);
	await expect(client.loadExtensions(session,["/tools/helper.py"])).rejects.toThrow(`plugin_load_unknown session=${session} plugin=${String(loaded?.plugin_id)}`);
	expect(writes).toBe(1);
	expect(loaded).toMatchObject({session_id:session, entry:"/tools/helper.py", name:"helper_py"});
	loaded = {...loaded,phase:"ready"};
	await client.loadExtensions(session,["/tools/helper.py","/tools/helper.py"]);
	expect(writes).toBe(1);
});

test("explicit themes work with no-themes while ordinary user themes remain available by default", async () => {
	const { mkdirSync, readFileSync, writeFileSync } = await import("node:fs");
	const { join } = await import("node:path");
	const { createTempDir } = await import("./temp-dir.ts");
	const { configureTuiThemes } = await import("../src/python-session-tui.ts");
	const { getAvailableThemes, getThemeByName, setRegisteredThemes } = await import("../src/modes/interactive/theme/theme.ts");
	const directory = createTempDir("amazme-cli-themes-");
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", directory);
	mkdirSync(join(directory,"themes"));
	const source: Record<string, unknown> = JSON.parse(readFileSync(new URL("../src/modes/interactive/theme/dark.json",import.meta.url),"utf8"));
	writeFileSync(join(directory,"themes","normal.json"),JSON.stringify({...source,name:"normal"}));
	const explicit = join(directory,"selected.json");
	writeFileSync(explicit, JSON.stringify({...source,name:"selected"}));
	try {
		await configureTuiThemes({themes:[explicit],theme:"selected"});
		expect(getAvailableThemes()).toContain("normal");
		expect(getThemeByName("selected")?.sourcePath).toBe(explicit);
		await configureTuiThemes({themes:[explicit],theme:"selected",noThemes:true});
		expect(getAvailableThemes()).not.toContain("normal");
		expect(getAvailableThemes()).toContain("selected");
		writeFileSync(explicit,'{"name":"bad","colors":{}}');
		await expect(configureTuiThemes({themes:[explicit]})).rejects.toThrow();
	} finally { setRegisteredThemes(undefined); vi.unstubAllEnvs(); }
});
