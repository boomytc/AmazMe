import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { PythonDesktopApi } from "../src/desktop-api.ts";
import type { PythonReady } from "../src/python-backend.ts";
import { createTempDir } from "./temp-dir.ts";

const CONTROL = "cd".repeat(32);
const WEB = "web-token";
const READY: PythonReady = {
	pageUrl: "http://127.0.0.1:4310/",
	origin: "http://127.0.0.1:4310",
	buildId: "ab".repeat(32),
	hostEpoch: 3,
	profileId: "profile",
};

function fixture(fetcher: ReturnType<typeof vi.fn<typeof fetch>>) {
	const profile = createTempDir("amazme-desktop-api-");
	writeFileSync(join(profile, "control.token"), CONTROL);
	return new PythonDesktopApi(() => READY, () => profile, () => WEB, fetcher);
}

describe("Python desktop lifecycle API", () => {
	test("activity uses the private control capability and rejects an invalid answer", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ active: true, tasks: 2 }));
		const api = fixture(fetcher);
		await expect(api.activity()).resolves.toEqual({ active: true });
		expect(fetcher.mock.calls[0]?.[0]).toBe("http://127.0.0.1:4310/control/desktop/activity");
		const options = fetcher.mock.calls[0]?.[1];
		expect(options?.headers).toEqual({ Authorization: `Bearer ${CONTROL}` });
		fetcher.mockResolvedValueOnce(Response.json({ tasks: 0 }));
		await expect(api.activity()).rejects.toThrow(/invalid/);
	});

	test("missing close preferences use safe defaults", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ revision: 4, preferences: { locale: "zh" } }));
		const api = fixture(fetcher);
		await expect(api.readPreferences()).resolves.toEqual({ closeWindow: "background", closeWindowPrompt: true });
	});

	test("remembering a choice updates the existing settings revision and preserves other preferences", async () => {
		const fetcher = vi.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ revision: 4, preferences: { locale: "zh", textSize: 17 } }))
			.mockResolvedValueOnce(Response.json({ revision: 5, preferences: { locale: "zh", textSize: 17, closeWindow: "quit", closeWindowPrompt: false } }));
		const api = fixture(fetcher);
		await api.savePreferences({ closeWindow: "quit", closeWindowPrompt: false });
		expect(fetcher).toHaveBeenCalledTimes(2);
		const [url, options] = fetcher.mock.calls[1] ?? [];
		expect(url).toBe("http://127.0.0.1:4310/api/v1/settings/preferences");
		expect(options?.method).toBe("PUT");
		expect(JSON.parse(String(options?.body))).toEqual({
			preferences: { locale: "zh", textSize: 17, closeWindow: "quit", closeWindowPrompt: false },
			expected_revision: 4,
		});
		expect(options?.headers).toMatchObject({ Authorization: `Bearer ${WEB}`, "x-amazme-build": READY.buildId, "x-amazme-epoch": "3" });
	});

	test("HTTP and acknowledgement failures are not treated as saved or idle", async () => {
		const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response("unavailable", { status: 503 }));
		const api = fixture(fetcher);
		await expect(api.activity()).rejects.toThrow("503");
		await expect(api.readPreferences()).rejects.toThrow("503");
	});
});
