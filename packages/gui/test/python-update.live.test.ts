import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, test } from "vitest";
import { createTempDir } from "./temp-dir.ts";
import {
	parsePythonUpdateRecord,
	pythonCompleteUpdateRequest,
	pythonPrepareUpdateRequest,
	pythonResumeUpdateRequest,
	pythonShutdownRequest,
	pythonUpdateAction,
	type PythonReady,
} from "../src/python-backend.ts";

const REPOSITORY = fileURLToPath(new URL("../../..", import.meta.url));
const SOURCE = join(REPOSITORY, ".artifacts/python-backend-electron/package-fe7_msbu/AmazMe Python 0.1.0/amazme-backend");

function readBuild(executable: string): string {
	const manifest = JSON.parse(readFileSync(join(executable, "..", "build.json"), "utf8")) as { build_id?: unknown };
	if (typeof manifest.build_id !== "string") throw new Error("missing build");
	return manifest.build_id;
}

function serve(executable: string, profile: string): { child: ChildProcess; ready: Promise<PythonReady> } {
	const child = spawn(executable, ["serve", "--profile", profile, "--port", "0"], {
		stdio: ["ignore", "pipe", "pipe"],
	});
	const ready = new Promise<PythonReady>((resolve, reject) => {
		let pending = "";
		let stderr = "";
		const timer = setTimeout(() => reject(new Error(`serve did not become ready\n${stderr.slice(-1500)}`)), 120_000);
		child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
		child.stdout?.on("data", (chunk: Buffer) => {
			pending += chunk.toString();
			while (pending.includes("\n")) {
				const newline = pending.indexOf("\n");
				const line = pending.slice(0, newline);
				pending = pending.slice(newline + 1);
				if (!line.startsWith("{")) continue;
				const parsed = JSON.parse(line) as { url?: string; build_id?: string; host_epoch?: number; protocol?: string; role?: string };
				if (typeof parsed.url !== "string" || typeof parsed.build_id !== "string" || typeof parsed.host_epoch !== "number") continue;
				clearTimeout(timer);
				resolve({ pageUrl: parsed.url, origin: parsed.url.replace(/\/$/, ""), buildId: parsed.build_id, hostEpoch: parsed.host_epoch, profileId: "profile" });
			}
		});
		child.once("exit", (code) => {
			clearTimeout(timer);
			reject(new Error(`serve exited ${String(code)}\n${stderr.slice(-1500)}`));
		});
	});
	return { child, ready };
}

async function stop(executable: string, profile: string, ready: PythonReady, control: string, web: string, child: ChildProcess): Promise<void> {
	const request = pythonShutdownRequest(ready, control, web);
	await fetch(request.url, { method: "POST", headers: request.headers, body: request.body }).catch(() => undefined);
	await new Promise<void>((resolve) => {
		const timer = setTimeout(() => {
			if (child.pid !== undefined) {
				try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
			}
			resolve();
		}, 20_000);
		child.once("exit", () => { clearTimeout(timer); resolve(); });
		spawn(executable, ["stop", "--profile", profile], { stdio: "ignore" });
	});
}

describe("desktop update admission on the packaged backend", () => {
	const children: ChildProcess[] = [];
	afterEach(() => {
		for (const child of children) {
			if (child.pid !== undefined) {
				try { process.kill(child.pid, "SIGKILL"); } catch { /* already exited */ }
			}
		}
		children.length = 0;
	});

	test("freezes the source build and activates only after the target build verifies", async () => {
		const targetExecutable = join(readFileSync(join(REPOSITORY, ".artifacts/python-backend-electron/latest-bundle"), "utf8").trim(), "amazme-backend");
		const sourceBuild = readBuild(SOURCE);
		const targetBuild = readBuild(targetExecutable);
		expect(sourceBuild).not.toBe(targetBuild);
		const root = createTempDir("amazme-python-update-");
		const workspace = join(root, "workspace");
		const profile = join(root, "profile");
		const provider = join(root, "provider.json");
		mkdirSync(workspace);
		writeFileSync(provider, JSON.stringify({
			provider: "faux", model: "faux", base_url: "", api_key: "", max_tokens: 2048, proxy: "", headers: {},
		}));
		const init = spawn(SOURCE, ["init", "--profile", profile, "--workspace", workspace, "--provider-config", provider, "--approval-policy", "auto"], { stdio: "ignore" });
		children.push(init);
		await new Promise<void>((resolve, reject) => init.once("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`init ${code}`)); }));
		const control = readFileSync(join(profile, "control.token"), "utf8").trim();
		const web = readFileSync(join(profile, "web.token"), "utf8").trim();

		const source = serve(SOURCE, profile);
		children.push(source.child);
		const sourceReady = await source.ready;
		expect(sourceReady.buildId).toBe(sourceBuild);
		const boot = await fetch(`${sourceReady.origin}/api/v1/bootstrap`, { headers: { Authorization: `Bearer ${web}` } });
		const identity = await boot.json() as { build_id: string; host_epoch: number };
		const fence = { "x-amazme-build": identity.build_id, "x-amazme-epoch": String(identity.host_epoch) };
		const created = await fetch(`${sourceReady.origin}/api/v1/sessions`, {
			method: "POST", headers: { Authorization: `Bearer ${web}`, "content-type": "application/json", ...fence },
			body: JSON.stringify({ title: "更新", workspace: "primary" }),
		});
		expect(created.status).toBe(201);
		const session = String(((await created.json()) as { session_id: string }).session_id);
		const attached = await fetch(`${sourceReady.origin}/api/v1/sessions/${session}/attachments`, {
			method: "POST", headers: { Authorization: `Bearer ${web}`, "content-type": "application/json", ...fence }, body: "{}",
		});
		const attachment = String(((await attached.json()) as { attachment_id: string }).attachment_id);
		const submitted = await fetch(`${sourceReady.origin}/api/v1/sessions/${session}/submissions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${web}`, "content-type": "application/json", ...fence, "x-amazme-attachment": attachment },
			body: JSON.stringify({ request_id: "before-update", text: "更新前" }),
		});
		expect(submitted.status).toBe(202);

		const prepare = pythonPrepareUpdateRequest(sourceReady, control, web, "desktop-update", targetBuild);
		const preparedResponse = await fetch(prepare.url, { method: "POST", headers: prepare.headers, body: prepare.body });
		const prepared = parsePythonUpdateRecord(await preparedResponse.json());
		expect(preparedResponse.status).toBe(200);
		expect(prepared?.phase).toBe("prepared");
		expect(prepared?.activated).toBe(false);
		expect(prepared?.targetBuild).toBe(targetBuild);
		expect(pythonUpdateAction(sourceBuild, {
			source_build: prepared?.sourceBuild ?? "", target_build: prepared?.targetBuild ?? "", activated: false, phase: prepared?.phase ?? "",
		})).toBe("hold");
		const refused = await fetch(`${sourceReady.origin}/api/v1/sessions/${session}/submissions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${web}`, "content-type": "application/json", ...fence, "x-amazme-attachment": attachment },
			body: JSON.stringify({ request_id: "during-freeze", text: "冻结中" }),
		});
		expect(refused.status).toBeGreaterThanOrEqual(400);
		const early = pythonCompleteUpdateRequest(sourceReady, control, web, "desktop-update", prepared?.revision ?? "0");
		const earlyResponse = await fetch(early.url, { method: "POST", headers: early.headers, body: early.body });
		expect(earlyResponse.status).toBe(409);
		const earlyBody = await earlyResponse.json() as { code?: string };
		expect(earlyBody.code).toBe("update_target_mismatch");

		await stop(SOURCE, profile, sourceReady, control, web, source.child);
		const restarted = serve(SOURCE, profile);
		children.push(restarted.child);
		const restartedReady = await restarted.ready;
		expect(pythonUpdateAction(restartedReady.buildId, {
			source_build: sourceBuild, target_build: targetBuild, activated: false, phase: "prepared",
		})).toBe("hold");
		const still = await fetch(`${restartedReady.origin}/control/updates/desktop-update`, { headers: { Authorization: `Bearer ${control}` } });
		const stillRecord = parsePythonUpdateRecord(await still.json());
		expect(stillRecord?.activated).toBe(false);
		const restartComplete = pythonCompleteUpdateRequest(restartedReady, control, web, "desktop-update", stillRecord?.revision ?? "0");
		expect((await fetch(restartComplete.url, { method: "POST", headers: restartComplete.headers, body: restartComplete.body })).status).toBe(409);
		await stop(SOURCE, profile, restartedReady, control, web, restarted.child);

		const target = serve(targetExecutable, profile);
		children.push(target.child);
		const targetReady = await target.ready;
		expect(targetReady.buildId).toBe(targetBuild);
		expect(pythonUpdateAction(targetReady.buildId, {
			source_build: sourceBuild, target_build: targetBuild, activated: false, phase: "prepared",
		})).toBe("verify");
		const resume = pythonResumeUpdateRequest(targetReady, control, web, "desktop-update");
		const verifiedResponse = await fetch(resume.url, { method: "POST", headers: resume.headers });
		const verified = parsePythonUpdateRecord(await verifiedResponse.json());
		expect(verifiedResponse.status).toBe(200);
		expect(verified?.activated).toBe(false);
		expect(verified?.validationPurpose).toBe("validation");
		expect(pythonUpdateAction(targetBuild, {
			source_build: sourceBuild, target_build: targetBuild, activated: false, phase: verified?.phase ?? "",
		})).toBe("activate");
		const complete = pythonCompleteUpdateRequest(targetReady, control, web, "desktop-update", verified?.revision ?? "");
		const activatedResponse = await fetch(complete.url, { method: "POST", headers: complete.headers, body: complete.body });
		const activated = parsePythonUpdateRecord(await activatedResponse.json());
		expect(activatedResponse.status).toBe(200);
		expect(activated?.activated).toBe(true);
		const health = await fetch(`${targetReady.origin}/api/v1/health`, { headers: { Authorization: `Bearer ${web}` } });
		const healthBody = await health.json() as { state?: string };
		expect(healthBody.state).not.toBe("frozen");
		const targetBoot = await fetch(`${targetReady.origin}/api/v1/bootstrap`, { headers: { Authorization: `Bearer ${web}` } });
		const targetIdentity = await targetBoot.json() as { build_id: string; host_epoch: number };
		const targetFence = { "x-amazme-build": targetIdentity.build_id, "x-amazme-epoch": String(targetIdentity.host_epoch) };
		const reattached = await fetch(`${targetReady.origin}/api/v1/sessions/${session}/attachments`, {
			method: "POST", headers: { Authorization: `Bearer ${web}`, "content-type": "application/json", ...targetFence }, body: "{}",
		});
		const nextAttachment = String(((await reattached.json()) as { attachment_id: string }).attachment_id);
		const after = await fetch(`${targetReady.origin}/api/v1/sessions/${session}/submissions`, {
			method: "POST",
			headers: { Authorization: `Bearer ${web}`, "content-type": "application/json", ...targetFence, "x-amazme-attachment": nextAttachment },
			body: JSON.stringify({ request_id: "after-update", text: "更新后" }),
		});
		expect(after.status).toBe(202);
		let answer = "";
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline && !answer.includes("已收到：更新后")) {
			const lookup = await fetch(`${targetReady.origin}/api/v1/sessions/${session}/requests/after-update`, { headers: { Authorization: `Bearer ${web}` } });
			const receipt = await lookup.json() as { answer?: string };
			answer = receipt.answer ?? "";
			if (!answer.includes("已收到：更新后")) await new Promise<void>((resolve) => setTimeout(resolve, 50));
		}
		expect(answer).toContain("已收到：更新后");
		writeFileSync(join(REPOSITORY, "docs/python-backend-desktop-update.json"), JSON.stringify({
			source_executable: SOURCE,
			target_executable: targetExecutable,
			source_build: sourceBuild,
			target_build: targetBuild,
			prepared_phase: prepared?.phase,
			source_activated: false,
			source_restart_activated: stillRecord?.activated,
			validation_purpose: verified?.validationPurpose,
			activated: activated?.activated,
			health_state: healthBody.state,
			answer,
		}, null, 2));
		await stop(targetExecutable, profile, targetReady, control, web, target.child);
	}, 180_000);
});
