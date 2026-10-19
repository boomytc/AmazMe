import { describe, expect, it, vi } from "vitest";
import type { PermissionDialog } from "../plugins/computer-use/src/permissions.ts";
import {
	PermissionGuide,
	permissionStatus,
} from "../plugins/computer-use/src/permissions.ts";

const path = "/tmp/AmazMe's Computer Use.app";
const missing = permissionStatus({
	content: [],
	structuredContent: {
		accessibility: false,
		screen_recording: false,
		host_path: path,
		driver_path: `${path}/Contents/MacOS/cua-driver`,
	},
});
const ready = permissionStatus({
	content: [],
	structuredContent: {
		accessibility: true,
		screen_recording: true,
		host_path: path,
		driver_path: `${path}/Contents/MacOS/cua-driver`,
	},
});

describe("computer-use permission guidance", () => {
	it("names the actual app and missing grants without treating an unknown report as ready", () => {
		expect(missing.missing).toEqual(["accessibility", "screen_recording"]);
		expect(missing.message).toContain(path);
		expect(missing.message).toContain("不会自动重发");
		expect(permissionStatus({ content: [] }).status).toBe("unknown");
		expect(ready.status).toBe("ready");
		expect(
			permissionStatus({
				content: [],
				structuredContent: { accessibility: true, screen_recording: false },
			}).missing,
		).toEqual(["screen_recording"]);
	});
	it("shows an already granted checklist only for explicit setup", async () => {
		const run = vi.fn<PermissionDialog["run"]>(async () => {});
		const guide = new PermissionGuide({ run }, "darwin");
		try {
			guide.offer(ready, async () => ready);
			expect(run).not.toHaveBeenCalled();
			guide.offer(ready, async () => ready, true);
			expect(run).toHaveBeenCalledTimes(1);
			await new Promise((resolve) => setImmediate(resolve));
			guide.offer(missing, async () => ready);
			expect(run).toHaveBeenCalledTimes(2);
		} finally {
			await guide.dispose();
		}
	});

	it("coalesces panels and permits explicit setup after dismissal", async () => {
		const run = vi.fn<PermissionDialog["run"]>(async () => {});
		const read = vi.fn(async () => ready);
		const guide = new PermissionGuide({ run }, "darwin");
		try {
			guide.offer(missing, read);
			guide.offer(missing, read);
			expect(run).toHaveBeenCalledTimes(1);
			expect(read).not.toHaveBeenCalled();
			await new Promise((resolve) => setImmediate(resolve));
			guide.offer(missing, read);
			expect(run).toHaveBeenCalledTimes(1);
			guide.offer(missing, read, true);
			expect(run).toHaveBeenCalledTimes(2);
		} finally {
			await guide.dispose();
		}
	});
	it("passes only a diagnostic callback to the panel and rearms after a grant is revoked", async () => {
		const run = vi.fn<PermissionDialog["run"]>(
			async (_report, read, signal) => {
				await read(signal);
			},
		);
		const read = vi.fn(async () => ready);
		const guide = new PermissionGuide({ run }, "darwin");
		try {
			guide.offer(missing, read);
			await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
			await new Promise((resolve) => setImmediate(resolve));
			guide.offer(missing, read);
			expect(run).toHaveBeenCalledTimes(2);
		} finally {
			await guide.dispose();
		}
	});
	it("joins panel cancellation and does not launch another panel after close", async () => {
		let stopped = false;
		const run = vi.fn<PermissionDialog["run"]>(
			async (_report, _read, signal) => {
				await new Promise<void>((resolve) =>
					signal.addEventListener(
						"abort",
						() => {
							stopped = true;
							resolve();
						},
						{ once: true },
					),
				);
			},
		);
		const guide = new PermissionGuide({ run }, "darwin");
		guide.offer(missing, async () => ready);
		await guide.dispose();
		expect(stopped).toBe(true);
		guide.offer(missing, async () => ready, true);
		expect(run).toHaveBeenCalledTimes(1);
	});
	it("keeps the gate closed if the panel fails or no native UI is available", async () => {
		const run = vi.fn<PermissionDialog["run"]>(async () => {
			throw new Error("headless");
		});
		const guide = new PermissionGuide({ run }, "darwin");
		guide.offer(missing, async () => ready);
		await guide.dispose();
		expect(missing.status).toBe("permission_required");
		for (const [platform, report] of [
			["linux", missing],
			["darwin", { ...missing, host_path: undefined }],
		] as const) {
			const unsupported = new PermissionGuide({ run }, platform);
			unsupported.offer(report, async () => ready);
			await unsupported.dispose();
		}
		expect(run).toHaveBeenCalledTimes(1);
	});
});
