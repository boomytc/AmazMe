import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { request as httpRequest } from "node:http";

import { Client } from "@amazme/client";
import { createWebSocketTransportFactory } from "@amazme/client/websocket";
import { promisify } from "node:util";
import { afterEach, describe, expect, test, vi } from "vitest";
import { webLaunchLines } from "../src/host/commands.ts";
import { buildBootManifest, injectBootManifest, requestLanguages, serveDocument } from "../src/host/web/boot.ts";
import type { WebBootManifest } from "@amazme/web";
import { readPageDocument } from "@amazme/web/assets";
import { Script } from "node:vm";
import { startWebHost, type WebHost } from "../src/host/web/host.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { DEFAULT_TYPOGRAPHY } from "@amazme/web/typography";

const hosts = new Set<WebHost>();
const directories = new Set<string>();

async function makeDirectory(prefix: string): Promise<string> {
	const directory = await mkdtemp(join(tmpdir(), prefix));
	directories.add(directory);
	return directory;
}

const execFileAsync = promisify(execFile);

async function runNode(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync(process.execPath, [...args], { encoding: "utf8" }).catch(
		(error: { stdout?: string; stderr?: string }) => ({
			stdout: error.stdout ?? "",
			stderr: error.stderr ?? String(error),
		}),
	);
	return { stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

async function startHost(port = 0): Promise<WebHost> {
	const directory = await makeDirectory("web-host-server-");
	const sessionDir = await makeDirectory("web-host-sessions-");
	const host = await startWebHost({ port, directory, sessionDir });
	hosts.add(host);
	return host;
}

/** Exercise the real HTTP upgrade without browser restrictions on Host/Origin test headers. */
async function requestEndpoint(url: string, headers: Record<string, string | string[]>, upgrade = false): Promise<{ status: number; body: string }> {
	const target = new URL(url);
	if (target.protocol === "ws:") target.protocol = "http:";
	return new Promise((resolve, reject) => {
		const request = httpRequest(target, {
			headers: Object.entries({
				...headers,
				...(upgrade ? { upgrade: "websocket", connection: "Upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", "sec-websocket-version": "13" } : { connection: "close" }),
			}).flatMap(([name, values]) => (Array.isArray(values) ? values : [values]).flatMap(value => [name, value])),
		}, response => {
			const chunks: Buffer[] = [];
			response.on("data", (chunk: Buffer) => chunks.push(chunk));
			response.once("error", reject);
			response.once("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
		});
		request.once("upgrade", (response, socket) => {
			socket.destroy();
			resolve({ status: response.statusCode ?? 0, body: "" });
		});
		request.once("error", reject);
		request.end();
	});
}

afterEach(async () => {
	await Promise.allSettled([...hosts].map((host) => host.close()));
	hosts.clear();
	await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true })));
	directories.clear();
});

describe("web boot manifest", () => {
	const manifest = buildBootManifest({
		appName: "AmazMe",
		version: "1.0.4",
		serverId: "00000000-0000-4000-8000-000000000001",
		transportUrl: "ws://127.0.0.1:1234/amazme",
		transportPath: "/amazme",
	});

	test("serves a localized standalone guard before the page entry", async () => {
		const document = serveDocument(await readPageDocument(), manifest, "zh-CN");
		const inline = [...document.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)?.[1];
		expect(document.lastIndexOf("<script>")).toBeLessThan(document.indexOf('<script id="amazme-page-entry"'));
		expect(inline).toBeDefined();
		expect(() => new Script(inline!)).not.toThrow();
		expect(inline).toContain("AmazMe 未能加载");
		expect(document).not.toContain("<!--amazme-startup-guard-->");
	});

	test("carries the app identity, mode, protocol version, transport, and preferences", () => {
		expect(manifest).toMatchObject({
			app: { name: "AmazMe", version: "1.0.4" },
			mode: "source",
			server: { id: "00000000-0000-4000-8000-000000000001" },
			transport: { url: "ws://127.0.0.1:1234/amazme", path: "/amazme" },
			// A host with no stored choice follows the browser and the system.
			preferences: { locale: "auto", appearance: "system" },
		});
		expect(typeof manifest.protocolVersion).toBe("number");
	});

	test("reads the languages one request asks for, most preferred first", () => {
		expect(requestLanguages("zh-CN,zh;q=0.9,en;q=0.8")).toEqual(["zh-CN", "zh", "en"]);
		expect(requestLanguages(undefined)).toEqual([]);
		expect(requestLanguages("")).toEqual([]);
	});

	test("injects the manifest into the document and escapes markup", () => {
		const html = injectBootManifest("<head><!--amazme-boot--></head>", manifest);
		expect(html).toContain("globalThis.__AMAZME_BOOT__=");
		expect(html).toContain("ws://127.0.0.1:1234/amazme");
		expect(html).not.toContain("<!--amazme-boot-->");

		const tricky = injectBootManifest("<head><!--amazme-boot--></head>", {
			...manifest,
			app: { name: "</script><script>alert(1)</script>", version: "1" },
		});
		// Only the wrapper's own closing tag survives; every markup character from the
		// manifest is escaped, so the script element cannot be terminated early.
		expect(tricky.split("</script>")).toHaveLength(2);
		expect(tricky).toContain("\\u003c/script>");
	});

	test("applies persisted typography in the head before the page module runs", () => {
		const preferences = { ...manifest.preferences, typography: { ...DEFAULT_TYPOGRAPHY, textFont: "Arial", textSize: 18, codeSize: 15, terminalSize: 16 } };
		const html = injectBootManifest("<head><!--amazme-boot--></head><body></body>", { ...manifest, preferences });
		const script = /<script>([\s\S]*?)<\/script>/u.exec(html)?.[1];
		if (script === undefined) throw new Error("Missing boot script");
		const properties = new Map<string, string>();
		new Script(script).runInNewContext({ document: { documentElement: { style: { setProperty: (name: string, value: string) => properties.set(name, value) } } } });
		expect(properties.get("--content-font-size")).toBe("18px");
		expect(properties.get("--code-font-size")).toBe("15px");
		expect(properties.get("--terminal-font-size")).toBe("16px");
		expect(properties.get("--font-content")).toBe('"Arial", var(--font-sans)');
		expect(html.indexOf("--content-font-size")).toBeLessThan(html.indexOf("<body>"));
	});

	test("leaves the document without a manifest when the host cannot boot it", () => {
		const html = injectBootManifest("<head><!--amazme-boot--></head>", undefined);
		expect(html).not.toContain("__AMAZME_BOOT__");
		expect(html).not.toContain("<!--amazme-boot-->");
	});

	test("refuses a document without the placeholder", () => {
		expect(() => injectBootManifest("<head></head>", manifest)).toThrow(/placeholder/);
	});
});

describe("web host", () => {
	test("rejects noncanonical HTTP hosts before reading preferences or exposing application assets", async () => {
		const host = await startHost();
		const address = new URL(host.url);
		const preferences = vi.spyOn(SettingsManager.prototype, "getLocalePreference");
		try {
			for (const authority of ["outside.example", `localhost:${address.port}`, `127.0.0.1:${Number(address.port) + 1}`]) {
				for (const path of ["/", "/page.js", "/tokens.css"]) {
					const response = await requestEndpoint(new URL(path, host.url).href, { host: authority });
					expect(response).toEqual({ status: 403, body: "Forbidden\n" });
				}
			}
			expect(await requestEndpoint(host.url, { host: [address.host, "outside.example"] })).toEqual({ status: 403, body: "Forbidden\n" });
			expect(preferences).not.toHaveBeenCalled();
			const allowed = await requestEndpoint(host.url, { host: address.host });
			expect(allowed.status).toBe(200);
			expect(allowed.body).toContain("globalThis.__AMAZME_BOOT__=");
			expect(preferences).toHaveBeenCalledTimes(1);
		} finally {
			preferences.mockRestore();
		}
	}, 60_000);

	test("accepts only same-origin browser upgrades and canonical local Node callers", async () => {
		const host = await startHost();
		const address = new URL(host.url);
		for (const origin of ["null", "https://outside.example", `http://127.0.0.1:${Number(address.port) + 1}`, `http://localhost:${address.port}`, `https://${address.host}`]) {
			expect((await requestEndpoint(host.webSocketUrl, { host: address.host, origin }, true)).status).toBe(403);
		}
		for (const authority of ["outside.example", `localhost:${address.port}`, "127.0.0.1"]) {
			expect((await requestEndpoint(host.webSocketUrl, { host: authority, origin: address.origin }, true)).status).toBe(403);
		}
		expect((await requestEndpoint(host.webSocketUrl, { host: [address.host, "outside.example"], origin: address.origin }, true)).status).toBe(403);
		expect((await requestEndpoint(host.webSocketUrl, { host: address.host, origin: [address.origin, "https://outside.example"] }, true)).status).toBe(403);
		expect((await requestEndpoint(host.webSocketUrl, { host: address.host, origin: address.origin }, true)).status).toBe(101);
		expect((await requestEndpoint(host.webSocketUrl, { host: address.host }, true)).status).toBe(101);
	}, 60_000);

	test(
		"serves the document with its boot manifest, the page bundle, and the protocol endpoint",
		async () => {
			const host = await startHost();
			expect(host.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
			expect(host.mode).toBe("source");
			expect(host.webSocketUrl).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/amazme$/);

			const page = await fetch(host.url);
			expect(page.status).toBe(200);
			expect(page.headers.get("content-type")).toContain("text/html");
			const html = await page.text();
			expect(html).toContain("globalThis.__AMAZME_BOOT__=");
			expect(html).toContain(host.webSocketUrl);
			expect(html).toContain(host.serverId);

			// The raw document is served as-is, so a page loaded without the host's injection has
			// no manifest to read: that is the visible "cannot boot" path, not a blank page. The
			// shell's own script reads the global for its palette, so look for the assignment.
			const raw = await fetch(new URL("/index.html", host.url));
			expect(raw.status).toBe(200);
			expect((await raw.text()).includes("globalThis.__AMAZME_BOOT__={")).toBe(false);

			const script = await fetch(new URL("/page.js", host.url));
			expect(script.status).toBe(200);
			expect(script.headers.get("content-type")).toContain("text/javascript");
			const code = await script.text();
			expect(code.length).toBeGreaterThan(10_000);
			// Parse the served bundle as a module: a syntax error here would be a page that cannot boot.
			const bundleFile = join(await makeDirectory("web-page-bundle-"), "page.mjs");
			await writeFile(bundleFile, code);
			const parsed = await runNode(["--check", bundleFile]);
			expect(parsed.stderr).toBe("");

			const client = new Client({
				serverId: host.serverId,
				transportFactory: createWebSocketTransportFactory({ url: host.webSocketUrl }),
			});
			await client.connect();
			expect(client.hello).toMatchObject({ serverId: host.serverId });
			await client.dispose();

			const launched = webLaunchLines(host);
			expect(launched[0]).toBe(`Web: ${host.url}`);
			expect(launched[1]).toBe("Mode: source");
			expect(launched.join("\n")).toContain(host.webSocketUrl);
		},
		60_000,
	);

	test(
		"serves the document in the stored language and palette, re-read for every request",
		async () => {
			const previousAgentDir = process.env.AMAZME_CODING_AGENT_DIR;
			const agentDir = await makeDirectory("web-host-agent-");
			process.env.AMAZME_CODING_AGENT_DIR = agentDir;
			try {
				const host = await startHost();
				// No stored choice: the page follows the browser's languages and the system palette.
				const plain = await fetch(host.url, { headers: { "accept-language": "en-US" } });
				const plainHtml = await plain.text();
				expect(plainHtml).toContain('<html lang="en">');
				expect(plainHtml).toContain("globalThis.__AMAZME_BOOT__=");
				expect(plainHtml).toContain('"preferences":{"locale":"auto","appearance":"system","typography":');
				expect(plainHtml).toContain("Filter sessions");
				expect(plainHtml).not.toContain("{{");

				// A browser asking in Chinese gets the Chinese shell even while the preference is auto.
				const asked = await fetch(host.url, { headers: { "accept-language": "zh-CN,zh;q=0.9" } });
				const askedHtml = await asked.text();
				expect(askedHtml).toContain('<html lang="zh-Hans">');
				expect(askedHtml).toContain("过滤会话");
				expect(askedHtml).toContain('"preferences":{"locale":"auto","appearance":"system","typography":');

				// A stored choice overrides the request and reaches the palette script.
				await writeFile(
					join(agentDir, "settings.json"),
					JSON.stringify({ locale: "zh", appearance: "dark", typography: { textFont: "Arial", textSize: 18, codeSize: 15, terminalSize: 16 } }),
					"utf8",
				);
				const stored = await fetch(host.url, { headers: { "accept-language": "en-US" } });
				const storedHtml = await stored.text();
				expect(storedHtml).toContain('<html lang="zh-Hans">');
				expect(storedHtml).toContain('"preferences":{"locale":"zh","appearance":"dark","typography":');
				expect(storedHtml).toContain("正在等待宿主…");
				expect(storedHtml).toContain('preference === "dark"');
				const bootScript = [...storedHtml.matchAll(/<script>([\s\S]*?)<\/script>/gu)].map(match => match[1]).find(script => script?.startsWith("globalThis.__AMAZME_BOOT__="));
				if (bootScript === undefined) throw new Error("Missing persisted boot preferences");
				const styles = new Map<string, string>();
				new Script(bootScript).runInNewContext({ document: { documentElement: { style: { setProperty: (name: string, value: string) => styles.set(name, value) } } } });
				expect(styles.get("--content-font-size")).toBe("18px");
				expect(styles.get("--font-content")).toBe('"Arial", var(--font-sans)');

				// The raw document keeps its markers: it is the unbootable page, not the served one.
				const raw = await fetch(new URL("/index.html", host.url));
				expect(await raw.text()).toContain("{{sidebar.filter}}");
			} finally {
				if (previousAgentDir === undefined) delete process.env.AMAZME_CODING_AGENT_DIR;
				else process.env.AMAZME_CODING_AGENT_DIR = previousAgentDir;
			}
		},
		60_000,
	);

	test(
		"answers 404 for unknown and escaping paths and 405 for other methods",
		async () => {
			const host = await startHost();
			expect((await fetch(new URL("/missing.js", host.url))).status).toBe(404);
			expect((await fetch(new URL("/%2e%2e/package.json", host.url))).status).toBe(404);
			expect((await fetch(host.url, { method: "POST" })).status).toBe(405);
		},
		60_000,
	);

	test(
		"a second launch in a deep directory attaches to the same socket",
		async () => {
			// Deep enough that `${id}.sock` exceeds sun_path. listen() still succeeds, but the
			// directory entry is a truncated name, so discovery does not see the canonical socket
			// and a second launch used to start another server.
			const root = await makeDirectory("wd-");
			const targetLength = 80;
			const directory = root.length >= targetLength ? root : join(root, "d".repeat(targetLength - root.length - 1));
			if (directory !== root) await mkdir(directory);
			const sessionDir = await makeDirectory("web-host-deep-sessions-");
			const canonicalBytes = Buffer.byteLength(join(directory, "00000000-0000-4000-8000-000000000000.sock"));
			const platformMax = process.platform === "linux" ? 108 : 103;
			expect(canonicalBytes).toBeGreaterThan(platformMax);

			const first = await startWebHost({ port: 0, directory, sessionDir });
			hosts.add(first);
			const second = await startWebHost({ port: 0, directory, sessionDir });
			hosts.add(second);

			const published = await readdir(directory);
			expect(first.ownsServer, `first directory: ${published.join(", ")}`).toBe(true);
			expect(second.ownsServer, `second directory: ${published.join(", ")}`).toBe(false);
			expect(second.serverId).toBe(first.serverId);
			expect(second.socketPath).toBe(first.socketPath);
			expect(second.socketPath.endsWith(`${second.serverId}.sock`)).toBe(true);
			expect((await lstat(second.socketPath)).isSocket()).toBe(true);
			const socketNames = await readdir(dirname(second.socketPath));
			expect(socketNames.filter((name) => name.startsWith(`server-${second.serverId}-`))).toHaveLength(1);
		},
		60_000,
	);

	test(
		"fails loudly when its port is taken and stops serving after close",
		async () => {
			const first = await startHost();
			const port = Number(new URL(first.url).port);
			await expect(startWebHost({ port, path: "/amazme" })).rejects.toThrow();
			expect((await fetch(first.url)).status).toBe(200);

			await first.close();
			const errors: Error[] = [];
			await createWebSocketTransportFactory({ url: first.webSocketUrl })({
				onData: () => {},
				onClose: () => {},
				onError: (error) => errors.push(error),
			});
			for (let attempt = 0; attempt < 50 && errors.length === 0; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(errors).toHaveLength(1);
			await first.close();
		},
		60_000,
	);
});
