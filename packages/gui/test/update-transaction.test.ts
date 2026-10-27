import { expect, test, vi } from "vitest";
import { replaceApplication, type UpdateTransactionIO } from "../src/updates/update-transaction.ts";

const paths = { target: "/Applications/AmazMe.app", staged: "/Applications/.update/AmazMe.app", backup: "/Applications/.update/Previous.app" };
function fixture(fault?: string) {
	const files = new Map([[paths.target, "old"], [paths.staged, "new"]]);
	const phases: string[] = [];
	const stop = vi.fn(async () => {});
	const io: UpdateTransactionIO = {
		verifyOriginal: async () => { if (fault === "original") throw new Error("busy"); },
		verifyCandidate: async () => { if (fault === "candidate") throw new Error("signature"); },
		rename: async (from, to) => { if (fault === "rename" && from === paths.staged) throw new Error("permission"); const content = files.get(from); if (!content || files.has(to)) throw new Error("rename"); files.set(to, content); files.delete(from); },
		launch: async () => { if (fault === "launch") throw new Error("spawn"); return { healthy: async () => { if (fault === "health") throw new Error("startup"); }, stop }; },
		relaunchOriginal: vi.fn(async () => {}), record: async phase => { phases.push(phase); },
	};
	return { files, phases, stop, io };
}
test("successful replacement retains the old bundle after a healthy new process", async () => {
	const { files, phases, io } = fixture(); await replaceApplication(paths, io);
	expect(files.get(paths.target)).toBe("new"); expect(files.get(paths.backup)).toBe("old"); expect(phases).toEqual(["replacing", "starting", "complete"]);
});
test.each(["original", "candidate"])("%s verification fails before moving any file", async fault => {
	const { files, phases, io } = fixture(fault); await expect(replaceApplication(paths, io)).rejects.toThrow();
	expect(files.get(paths.target)).toBe("old"); expect(files.has(paths.backup)).toBe(false); expect(phases).toEqual([]);
});
test.each(["rename", "launch", "health"])("%s failure restores the original without deleting user data", async fault => {
	const { files, phases, stop, io } = fixture(fault); await expect(replaceApplication(paths, io)).rejects.toThrow();
	expect(files.get(paths.target)).toBe("old"); expect(files.get(paths.staged)).toBe("new"); expect(phases).toContain("rolled-back"); expect(io.relaunchOriginal).toHaveBeenCalledOnce();
	if (fault === "health") expect(stop).toHaveBeenCalledOnce();
});
test("an uncooperative new process stops rollback and preserves both app copies", async () => {
	const { files, phases, io } = fixture("health");
	io.launch = async () => ({ healthy: async () => { throw new Error("startup"); }, stop: async () => { throw new Error("still running"); } });
	await expect(replaceApplication(paths, io)).rejects.toThrow();
	expect(phases).toContain("recovery-required"); expect(files.get(paths.backup)).toBe("old"); expect(files.get(paths.target)).toBe("new");
});
