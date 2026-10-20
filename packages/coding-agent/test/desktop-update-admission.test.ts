import { expect, test } from "vitest";
import { authorizedDesktopUpdate, takeDesktopUpdateToken, DESKTOP_UPDATE_TOKEN_ENV } from "../src/host/web/desktop-update.ts";
import { SessionWorkerManager } from "../src/host/session-worker-manager.ts";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";

test("private desktop token is removed before workers inherit env, and browsers cannot prepare a restart", () => {
	const token = "a".repeat(64), env = { [DESKTOP_UPDATE_TOKEN_ENV]: token };
	expect(takeDesktopUpdateToken(env)).toBe(token); expect(env[DESKTOP_UPDATE_TOKEN_ENV]).toBeUndefined();
	expect(authorizedDesktopUpdate({ method: "POST", headers: { "x-amazme-desktop-update": token } }, token)).toBe(true);
	for (const request of [{ method: "GET", headers: { "x-amazme-desktop-update": token } }, { method: "POST", headers: { origin: "http://127.0.0.1", "x-amazme-desktop-update": token } }, { method: "POST", headers: {} }, { method: "POST", headers: { "x-amazme-desktop-update": "b".repeat(64) } }]) {
		expect(authorizedDesktopUpdate(request, token)).toBe(false);
	}
});
test("successful admission freezes new work; cancellation releases the freeze", async () => {
	const workers = new SessionWorkerManager({ controlPath: "/tmp/control", serverConnectionId: "generation", wasReplaced: false, onEvent: () => () => {}, send: async () => {}, broadcast: async () => {} }, "/tmp");
	try {
		expect(await workers.prepareForUpdate(BACKGROUND_CONTEXT)).toBe(true);
		expect(await workers.prepareForUpdate(BACKGROUND_CONTEXT)).toBe(false);
		await expect(workers.openSession({ id: "test", cwd: "/tmp", path: "/tmp/test", createdAt: 1 }, BACKGROUND_CONTEXT, [])).rejects.toThrow("shutting down");
		workers.resumeAfterUpdate();
		expect(await workers.prepareForUpdate(BACKGROUND_CONTEXT)).toBe(true);
	} finally { workers.detach(); }
});
