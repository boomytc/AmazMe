import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { expect, test, vi } from "vitest";
import { SessionMirror } from "../src/host/services/session-mirror.ts";
import { openWorkerTestServices } from "./native-host-support.ts";
import { startSessionHandoff } from "../src/host/session-handoff.ts";
import { mirrorPath } from "../src/host/session-store.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

test("worker catalogue and replicated state expose real mirror conflicts without model transcript entries", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "amazme-mirror-service-"));
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", join(cwd, "profile"));
	const opened = await openFauxConversation();
	const handoff = await startSessionHandoff({ conversation: opened.conversation, cwd, sessionId: "wire-session", createdAt: 1, report: () => {} });
	const services = await openWorkerTestServices({
		cwd, harness: opened.harness, conversation: opened.conversation, modelRuntime: undefined, mirror: handoff,
	});
	try {
		await handoff.refresh();
		const catalogue = await services.worker.invoke({ kind: "catalogue" }, { serverConnectionId: "test-server", attachmentId: "test-attachment" }, BACKGROUND_CONTEXT);
		expect(catalogue).toContainEqual({ serviceId: SessionMirror.name });
		const mirror = services.services.get(SessionMirror);
  await services.services.ready();
  expect(mirror.state.value).toEqual({ warning: null });
		const path = mirrorPath(cwd, "wire-session", 1);
		const external = (await readFile(path, "utf8")) + "terminal external append\n";
		await writeFile(path, external);
		await handoff.refresh();
		await expect.poll(() => mirror.state.value?.warning?.detail).toContain("terminal file was changed by another writer");
		expect(await readFile(path, "utf8")).toBe(external);

		expect((await opened.conversation.entries({ order: "ascending" }, 10, undefined, BACKGROUND_CONTEXT)).items).toEqual([]);
	} finally {
		await services.close();
		await handoff.dispose();
		await opened.close();
		vi.unstubAllEnvs();
		await rm(cwd, { recursive: true, force: true });
	}
});
