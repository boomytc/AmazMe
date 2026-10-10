import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { DESKTOP_PARENT_PIPE_ENV, watchDesktopParent } from "../src/host/desktop-parent.ts";

describe("desktop-owned web host parent pipe", () => {
	test("only watches explicitly owned hosts and does not consume ordinary stdin", () => {
		const input = new PassThrough();
		const closed = vi.fn();
		const stop = watchDesktopParent(closed, input, {});
		expect(input.listenerCount("end")).toBe(0);
		expect(input.readableFlowing).not.toBe(true);
		stop();
		input.destroy();
		expect(closed).not.toHaveBeenCalled();
	});
	test("EOF notifies once and removes the flag before workers can inherit it", async () => {
		const input = new PassThrough();
		const env = { [DESKTOP_PARENT_PIPE_ENV]: "1" };
		const closed = vi.fn();
		const ended = new Promise<void>((resolve) => input.once("end", resolve));
		const stop = watchDesktopParent(closed, input, env);
		expect(env[DESKTOP_PARENT_PIPE_ENV]).toBeUndefined();
		input.end();
		await ended;
		input.emit("close");
		expect(closed).toHaveBeenCalledTimes(1);
		stop();
		expect(input.listenerCount("end")).toBe(0);
		expect(input.listenerCount("close")).toBe(0);
	});
	test("handles early parent loss and disposal without a late shutdown", () => {
		const input = new PassThrough();
		input.destroy();
		const closed = vi.fn();
		watchDesktopParent(closed, input, { [DESKTOP_PARENT_PIPE_ENV]: "1" })();
		expect(closed).toHaveBeenCalledTimes(1);
		const live = new PassThrough();
		const late = vi.fn();
		watchDesktopParent(late, live, { [DESKTOP_PARENT_PIPE_ENV]: "1" })();
		live.emit("end");
		expect(late).not.toHaveBeenCalled();
		live.destroy();
	});
});
