import { afterEach, expect, test, vi } from "vitest";
import { handoffUpdate, type UpdateHelperPort } from "../src/update-handoff.ts";

afterEach(() => vi.useRealTimers());
function portFixture() {
	const data = new Set<(chunk: string) => void>(), deaths = new Set<() => void>();
	let alive = true;
	const port: UpdateHelperPort = {
		onData: listener => { data.add(listener); return () => data.delete(listener); },
		onDeath: listener => { deaths.add(listener); return () => deaths.delete(listener); },
		isAlive: () => alive, sendInstall: vi.fn(async () => {}), cancel: vi.fn(),
	};
	return { port, data: (chunk: string) => { for (const fn of data) fn(chunk); }, die: () => { alive = false; for (const fn of deaths) fn(); } };
}
test("a confirmation left open for five minutes starts no helper and never quits", async () => {
	vi.useFakeTimers();
	const fixture = portFixture();
	let answer: ((value: boolean) => void) | undefined;
	const confirm = () => new Promise<boolean>(resolve => { answer = resolve; });
	const start = vi.fn(() => fixture.port), quit = vi.fn(async () => {}), resume = vi.fn(async () => {});
	const operation = handoffUpdate({ confirm, start, quit, resume, timeoutMs: 60_000 });
	await vi.advanceTimersByTimeAsync(300_000);
	expect(start).not.toHaveBeenCalled(); expect(quit).not.toHaveBeenCalled();
	answer?.(false); await expect(operation).rejects.toThrow("postponed");
	expect(resume).toHaveBeenCalledOnce();
});
test("ready alone never permits quit; explicit armed ACK is required", async () => {
	const f = portFixture(), quit = vi.fn(async () => {}), resume = vi.fn(async () => {});
	const operation = handoffUpdate({ confirm: async () => true, start: () => f.port, quit, resume });
	await Promise.resolve(); f.data("ready\n"); await Promise.resolve(); await Promise.resolve();
	expect(quit).not.toHaveBeenCalled();
	f.data("armed\n"); await operation;
	expect(quit).toHaveBeenCalledOnce(); expect(resume).not.toHaveBeenCalled();
});
test("helper death after ready aborts handoff and resumes the host", async () => {
	const f = portFixture(), quit = vi.fn(async () => {}), resume = vi.fn(async () => {});
	const operation = handoffUpdate({ confirm: async () => true, start: () => f.port, quit, resume });
	const result = expect(operation).rejects.toThrow("install");
	await Promise.resolve(); f.data("ready\n"); f.die();
	await result; expect(quit).not.toHaveBeenCalled(); expect(resume).toHaveBeenCalledOnce();
});
test("broken install pipe or missing armed ACK never quits", async () => {
	const f = portFixture(); f.port.sendInstall = async () => { throw new Error("install"); };
	const quit = vi.fn(async () => {}), resume = vi.fn(async () => {});
	const operation = handoffUpdate({ confirm: async () => true, start: () => f.port, quit, resume });
	const result = expect(operation).rejects.toThrow("install");
	await Promise.resolve(); f.data("ready\n"); await result;
	expect(quit).not.toHaveBeenCalled(); expect(f.port.cancel).toHaveBeenCalledOnce(); expect(resume).toHaveBeenCalledOnce();
});
test("a helper which stays alive but never arms times out without quitting", async () => {
	vi.useFakeTimers();
	const f = portFixture(), quit = vi.fn(async () => {}), resume = vi.fn(async () => {});
	const operation = handoffUpdate({ confirm: async () => true, start: () => f.port, quit, resume, timeoutMs: 1000 });
	const result = expect(operation).rejects.toThrow("install");
	await Promise.resolve(); f.data("ready\n");
	await vi.advanceTimersByTimeAsync(1001); await result;
	expect(quit).not.toHaveBeenCalled(); expect(resume).toHaveBeenCalledOnce();
});
