import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { ServiceHost } from "@amazme/protocol/services";
import { describe, expect, test, vi } from "vitest";
import { cli } from "../src/cli/host/cli.ts";
import { prepareClientSession } from "../src/host/client-tui.ts";
import type { ClientTuiServer } from "../src/host/client-tui.ts";
import { connectTestHost } from "./native-host-support.ts";
import { PresentationPlugins } from "../src/host/services/plugins.ts";
import {
	SessionDirectory,
	type SessionDirectoryState,
	SessionManagement,
	type SessionSummary,
} from "../src/host/services/sessions.ts";

const serverId = "00000000-0000-4000-8000-000000000001";

function summary(sessionId: string): SessionSummary {
	return { serverId, sessionId, createdAt: 1, cwd: "/tmp/session-cwd", source: "host" };
}

describe("client session selection", () => {
	test("--session-id opens only an existing Session and --new-session-id creates", async () => {
		const directory = replicatedState<SessionDirectoryState>({ revision: 1, sessions: [summary("existing")] });
		const create = vi.fn(async (options: { id?: string }) => {
			const created = summary(options.id ?? "generated");
			directory.change(BACKGROUND_CONTEXT, (draft) => {
				draft.revision += 1;
				draft.sessions.push(created);
			});
			return created;
		});
		const provider = new ServiceHost("server");
		provider.provide(SessionDirectory, { state: directory });
		provider.provide(PresentationPlugins, {
			async prepareSession() {
				return {};
			},
			async reload() {
				return {};
			},
		});
		provider.provide(SessionManagement, {
			create,
			async remove() {},
			async attach() {},
			async detach() {},
			async rename(id) {
				const current = directory.value.sessions.find((session) => session.sessionId === id);
				if (current === undefined) throw new Error(`Unknown session: ${id}`);
				return current;
			},
		});
		await provider.ready();
		const server: ClientTuiServer = {
			serverId,
			radius: false,
			server: {
				async catalogue() {
					await provider.ready();
					return provider.catalogue.filter((entry) => !entry.local);
				},
				open(options) {
					const peer = connectTestHost(provider.host);
					for (const service of options.services) peer.scope.get(service);
					return {
						get: peer.scope.get.bind(peer.scope),
						ready: peer.scope.ready.bind(peer.scope),
						dispose: () => peer.close(),
					};
				},
				async dispose() {},
				connection: replicatedState({ status: "connected" as const, since: "now" }),
			},
			session: {
				async catalogue() {
					return [];
				},
				open() {
					throw new Error("Session services are not used by startup selection");
				},
				async dispose() {},
				attachment: replicatedState({ status: "detached" as const }),
				async whenAttached() {},
				async whenDetached() {},
			},
		};
		try {
			await expect(
				prepareClientSession({ command: "client", sessionId: "missing" }, [server]),
			).rejects.toThrow("No Session missing exists");
			expect(create).not.toHaveBeenCalled();
			expect(directory.value.sessions.map((session) => session.sessionId)).toEqual(["existing"]);

			const opened = await prepareClientSession({ command: "client", sessionId: "existing" }, [server]);
			expect(opened.summary.sessionId).toBe("existing");
			expect(create).not.toHaveBeenCalled();

			const created = await prepareClientSession({ command: "client", newSessionId: "fresh" }, [server]);
			expect(created.summary.sessionId).toBe("fresh");
			expect(create).toHaveBeenCalledWith({ id: "fresh" }, expect.anything());
		} finally {
			await provider.dispose();
		}
	});

	test("parses the two ID flags as separate paths", () => {
		const parsed = cli.parse(["client", "--new-session-id", "fresh"]);
		expect(parsed).toMatchObject({ ok: true, command: { command: "client", newSessionId: "fresh" } });
		const conflict = cli.parse(["client", "--session-id", "a", "--new-session-id", "b"]);
		expect(conflict.ok).toBe(false);
		if (conflict.ok) return;
		expect(conflict.errors.join("\n")).toContain("mutually exclusive");
	});
});
