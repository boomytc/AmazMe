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
	expect(client.connectionInfo()).toContain('"profile":"host"');
	expect(client.connectionInfo()).not.toContain("private");
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

test("scoped models keep the current choice, cycle with their thinking levels, and submit immutable model defaults", async () => {
	let current = {provider:"one",model:"a"};
	const sent: Record<string,unknown>[] = [];
	const choices = [
		{model:{provider:"one",model:"a"},thinking:"low"},
		{model:{provider:"two",model:"b"},thinking:"high"},
	];
	vi.stubGlobal("fetch",vi.fn(async (url:string,init?:RequestInit) => {
		const body = init?.body ? JSON.parse(String(init.body)) as Record<string,unknown> : {};
		if (url.endsWith("/bootstrap")) return reply({build_id:"build",host_epoch:1});
		if (url.endsWith("/models/scope")) return reply({models:JSON.stringify(body.patterns)==='["two/b"]' ? [choices[1]] : choices,diagnostics:[]});
		if (url.includes("/session-models/")) {
			if (init?.method === "PUT") current = {provider:String(body.provider),model:String(body.model)};
			return reply({...current,session_id:session});
		}
		if (url.endsWith("/sessions")) return reply({sessions:[{session_id:session,workspace:"primary"}]});
		if (url.includes("/requests/")) return reply({status:"succeeded"});
		if (url.endsWith("/submissions")) { sent.push(body); return reply({}); }
		if (url.endsWith("/rpc")) { sent.push(body); return reply({}); }
		throw new Error(url);
	}));
	const client = new HostClient("http://host", "private");
	await client.bootstrap();
	await client.configureModels({modelPatterns:["*"],modelRef:"two/b"},session);
	expect(current).toEqual({provider:"two",model:"b"});
	await client.submit(session,"primary","attachment","first",[],"first");
	expect(sent[0]).toMatchObject({model_selection:{provider:"two",model:"b"},thinking:"high"});
	expect(await client.cycleModel(session)).toBe("one/a");
	await client.submit(session,"primary","attachment","second",[],"second");
	expect(sent[1]).toMatchObject({model_selection:{provider:"one",model:"a"},thinking:"low"});
	client.setThinking("max");
	await client.cycleModel(session);
	await client.rpc({method:"request.submit",params:{text:"rpc"}});
	expect(sent[2]).toMatchObject({params:{model_selection:{provider:"two",model:"b"},thinking:"max"}});
});
