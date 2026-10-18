import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

function execute(args: readonly string[], options: ExecFileOptions): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = execFile(process.execPath, args, { ...options, encoding: "utf8" }, (error, stdout, stderr) => {
			if (error) reject(Object.assign(error, { stdout, stderr }));
			else resolve({ stdout, stderr });
		});
		// Print mode reads piped stdin before starting; this fixture has no piped input.
		child.stdin?.end();
	});
}
const cli = fileURLToPath(new URL("../dist/bundle/cli.js", import.meta.url));
type Payload = { tools?: { function: { name: string } }[] };

describe("compiled CLI tool selection", () => {
	let directory: string;
	let profile: string;
	let server: Server;
	let payloads: Payload[];

	beforeEach(async () => {
		directory = mkdtempSync(join(tmpdir(), "amazme-cli-tools-"));
		profile = join(directory, "profile");
		payloads = [];
		server = createServer((request, response) => {
			if (request.url !== "/v1/chat/completions") {
				response.writeHead(404).end();
				return;
			}
			const chunks: Buffer[] = [];
			request.on("data", (chunk: Buffer) => chunks.push(chunk));
			request.on("end", () => {
				payloads.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Payload);
				response.writeHead(200, { "content-type": "text/event-stream" });
				for (const choice of [
					{ index: 0, delta: { role: "assistant", content: "fixture answer" }, finish_reason: null },
					{ index: 0, delta: {}, finish_reason: "stop" },
				])
					response.write(
						`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", created: 0, model: "scripted", choices: [choice] })}\n\n`,
					);
				response.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolve);
		});
	});

	afterEach(async () => {
		server.closeAllConnections();
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
		rmSync(directory, { recursive: true, force: true });
	});

	const options = () => ({
		cwd: directory,
		timeout: 15_000,
		env: { ...process.env, AMAZME_CODING_AGENT_DIR: profile, AMAZME_OFFLINE: "1" },
	});

	it("passes edited defaults to the real compiled provider request", async () => {
		mkdirSync(profile);
		writeFileSync(
			join(profile, "models.json"),
			JSON.stringify({
				providers: {
					fixture: {
						api: "openai-completions",
						apiKey: "fixture-key",
						baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
						models: [{ id: "scripted" }],
					},
				},
			}),
		);
		const result = await execute(
			[
				cli,
				"--provider",
				"fixture",
				"--model",
				"scripted",
				"--tools",
				"+grep,-write",
				"--print",
				"Describe the available tools",
			],
			options(),
		);
		expect(result.stdout).toContain("fixture answer");
		expect(payloads).toHaveLength(1);
		expect(payloads[0].tools?.map((tool) => tool.function.name).sort()).toEqual(["bash", "edit", "grep", "read"]);
	});

	it("rejects a mixed list before profile creation and provider I/O", async () => {
		await expect(
			execute([cli, "--tools", "read,+grep", "--print", "test"], options()),
		).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining("tool names cannot be mixed") });
		expect(existsSync(profile)).toBe(false);
		expect(payloads).toEqual([]);
	});
});
