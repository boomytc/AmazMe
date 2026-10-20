import { describe, expect, test, vi } from "vitest";
import { createUpdateController, type DesktopUpdateIO, type UpdateState } from "../src/update-controller.ts";

const release = { manifest: { version: "8.6.0", tag: "v8.6.0", assets: [] }, asset: { name: "update.dmg", url: "https://github.com/boomytc/AmazMe/releases/download/v8.6.0/update.dmg", sha256: "c".repeat(64), size: 3 } };
function setup(overrides: Partial<DesktopUpdateIO> = {}) {
	const states: UpdateState[] = [];
	const io = { check: vi.fn(async () => release), download: vi.fn(async () => "/private/download/update.dmg"),
		verify: vi.fn(async () => ({ directory: "/Applications/.AmazMe-update-xyz" })), discard: vi.fn(async () => {}), install: vi.fn(async () => {}), ...overrides } satisfies DesktopUpdateIO;
	return { io, states, controller: createUpdateController("8.5.0", io, state => states.push(state)) };
}
describe("desktop update consent and concurrency", () => {
	test("checking never downloads; verified downloads never install on ordinary quit", async () => {
		const { controller, io, states } = setup();
		await controller.check();
		expect(controller.state().phase).toBe("available"); expect(io.download).not.toHaveBeenCalled();
		await controller.download();
		expect(states.map(s => s.phase)).toEqual(["checking", "available", "downloading", "verifying", "ready"]);
		expect(io.install).not.toHaveBeenCalled(); await controller.dispose(); expect(io.install).not.toHaveBeenCalled();
		expect(io.discard).toHaveBeenCalledWith(undefined, { directory: "/Applications/.AmazMe-update-xyz" });
	});
	test("duplicate checks, downloads and install clicks join one operation", async () => {
		const { controller, io } = setup();
		await Promise.all([controller.check(), controller.check()]);
		await Promise.all([controller.download(), controller.download()]);
		await Promise.all([controller.install(), controller.install()]);
		expect(io.check).toHaveBeenCalledOnce(); expect(io.download).toHaveBeenCalledOnce(); expect(io.verify).toHaveBeenCalledOnce(); expect(io.install).toHaveBeenCalledOnce();
		await controller.dispose();
		expect(io.discard).not.toHaveBeenCalledWith(undefined, { directory: "/Applications/.AmazMe-update-xyz" });
	});
	test("cancelled download is discarded and can be retried", async () => {
		const { controller, io } = setup({ download: vi.fn((_asset, signal) => new Promise<string>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("network"))))) });
		await controller.check(); const work = controller.download(); controller.cancel(); await work;
		expect(controller.state().phase).toBe("available"); expect(io.verify).not.toHaveBeenCalled(); expect(io.install).not.toHaveBeenCalled();
	});
	test.each(["integrity", "signature", "permission", "network"])("%s failure never becomes installable", async code => {
		const { controller, io } = setup({ verify: vi.fn(async () => { throw new Error(code); }) });
		await controller.check(); await controller.download(); await controller.install();
		expect(controller.state().error).toBe(code); expect(io.install).not.toHaveBeenCalled();
	});
	test("busy install preserves the verified candidate for a later explicit retry", async () => {
		const { controller, io } = setup({ install: vi.fn(async () => { throw new Error("busy"); }) });
		await controller.check(); await controller.download(); await controller.install();
		expect(controller.state()).toMatchObject({ phase: "ready", error: "busy" });
		expect(io.install).toHaveBeenCalledOnce();
	});
});
