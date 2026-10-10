import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServiceCatalogueCall, createServiceSubscribeCall } from "@amazme/chord";
import type { ServiceProviderUpdate } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { expect, test, vi } from "vitest";
import { SessionMirror } from "../src/host/services/session-mirror.ts";
import { createSessionWorkerServices } from "../src/host/services/worker.ts";
import { startSessionHandoff } from "../src/host/session-handoff.ts";
import { mirrorPath } from "../src/host/session-store.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

test("worker catalogue and replicated state expose real mirror conflicts without model transcript entries", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "amazme-mirror-service-"));
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(cwd, "profile"));
	const opened = await openFauxConversation();
	const handoff = await startSessionHandoff({ conversation: opened.conversation, cwd, sessionId: "wire-session", createdAt: 1, report: () => {} });
	const updates: ServiceProviderUpdate[] = [];
	const services = await createSessionWorkerServices({
		cwd, harness: opened.harness, conversation: opened.conversation, modelRuntime: undefined, mirror: handoff,
		async publish(_scope, _subscriptionId, update) { updates.push(update); },
	});
	const scope = { serverConnectionId: "server-1", attachmentId: "attachment-1" };
	try {
		await handoff.refresh();
		const catalogue = await services.invoke(createServiceCatalogueCall(), scope, BACKGROUND_CONTEXT);
		expect(catalogue).toContainEqual({ serviceId: SessionMirror.id, mode: "singleton" });
		const initial = await services.invoke(createServiceSubscribeCall("mirror", SessionMirror.id, "singleton"), scope, BACKGROUND_CONTEXT);
		expect(JSON.stringify(initial)).toContain('"warning":null');
		const path = mirrorPath(cwd, "wire-session", 1);
		const external = (await readFile(path, "utf8")) + "terminal external append\n";
		await writeFile(path, external);
		await handoff.refresh();
		expect(JSON.stringify(updates)).toContain("terminal file was changed by another writer");
		expect(await readFile(path, "utf8")).toBe(external);
		const snapshot = await services.invoke(createServiceSubscribeCall("mirror-late", SessionMirror.id, "singleton"), scope, BACKGROUND_CONTEXT);
		expect(JSON.stringify(snapshot)).toContain("terminal file was changed by another writer");
		expect((await opened.conversation.entries({ order: "ascending" }, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
	} finally {
		await services.dispose();
		await handoff.dispose();
		await opened.close();
		vi.unstubAllEnvs();
		await rm(cwd, { recursive: true, force: true });
	}
});
