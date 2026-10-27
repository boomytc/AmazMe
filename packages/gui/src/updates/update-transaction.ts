export interface UpdateTransaction {
	readonly target: string;
	readonly staged: string;
	readonly backup: string;
}
export interface UpdateTransactionIO {
	verifyOriginal(): Promise<void>;
	verifyCandidate(): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	launch(): Promise<{ healthy(): Promise<void>; stop(): Promise<void> }>;
	relaunchOriginal(): Promise<void>;
	record(phase: "replacing" | "starting" | "complete" | "rolled-back" | "recovery-required"): Promise<void>;
}

/** Keep the original bundle until a new process reports a loaded desktop and live host. */
export async function replaceApplication(paths: UpdateTransaction, io: UpdateTransactionIO): Promise<void> {
	await io.verifyOriginal();
	await io.verifyCandidate();
	await io.record("replacing");
	await io.rename(paths.target, paths.backup);
	let installed = false;
	let process: Awaited<ReturnType<UpdateTransactionIO["launch"]>> | undefined;
	try {
		await io.rename(paths.staged, paths.target); installed = true;
		await io.record("starting");
		process = await io.launch();
		await process.healthy();
		await io.record("complete");
	} catch (error) {
		try {
			await process?.stop();
			if (installed) await io.rename(paths.target, paths.staged);
			await io.rename(paths.backup, paths.target);
			await io.record("rolled-back");
			await io.relaunchOriginal();
		} catch { await io.record("recovery-required"); }
		throw error;
	}
}
