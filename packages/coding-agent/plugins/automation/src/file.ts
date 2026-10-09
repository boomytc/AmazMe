import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, realpath, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { Context, MutableReplicatedState } from "@amazme/chord";
import type { ScheduleRecord, SchedulesState } from "@amazme/coding-agent/plugin";
import { parseSchedule } from "./records.ts";

/** Read-only activation; acquire a canonical file lease only before mutations or delivery. */
export function createScheduleFile(
	options: {
		readonly agentDir: () => string;
		readonly hostId: () => string;
		readonly tickMs: number;
		onCompromised(error: Error): void;
	},
	state: MutableReplicatedState<SchedulesState>,
) {
	let path = "";
	let hostId = "";
	let problem: string | null = null;
	let contents: string | undefined;
	let schedules: ScheduleRecord[] = [];
	let releaseLease: (() => Promise<void>) | undefined;
	let leaseError: Error | undefined;
	const tickMs = options.tickMs;
	const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error));
	const publish = (context: Context): void => {
		state.change(context, (draft) => {
			draft.revision += 1;
			draft.path = path;
			draft.tickMs = tickMs;
			draft.problem = problem;
			draft.schedules = schedules;
		});
	};
	const read = async (): Promise<string | undefined> => {
		try {
			return await readFile(path, "utf8");
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
			throw error;
		}
	};
	const load = async (context: Context): Promise<void> => {
		problem = null;
		schedules = [];
		try {
			contents = await read();
			const parsed: unknown = contents === undefined ? { version: 2, hostId, schedules: [] } : JSON.parse(contents);
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				!("version" in parsed) ||
				parsed.version !== 2 ||
				!("hostId" in parsed) ||
				parsed.hostId !== hostId ||
				!("schedules" in parsed) ||
				!Array.isArray(parsed.schedules)
			)
				throw new Error("Expected version 2 and this host's ID. Each plan needs an explicit conversation target.");
			schedules = parsed.schedules.flatMap((value: unknown) => {
				const record = parseSchedule(value);
				return record === undefined ? [] : [record];
			});
			if (
				schedules.length !== parsed.schedules.length ||
				new Set(schedules.map((record) => record.id)).size !== schedules.length
			)
				throw new Error("Invalid schedule records. Repair the file and reload.");
		} catch (error) {
			problem = `Cannot read ${path}: ${describe(error)}`;
			if (contents === undefined) schedules = [];
		}
		if (leaseError !== undefined) problem = `Schedules ownership was lost: ${describe(leaseError)} Restart this host.`;
		publish(context);
	};
	const own = async (context: Context): Promise<void> => {
		if (leaseError !== undefined) throw leaseError;
		if (problem !== null) throw new Error(problem);
		if (releaseLease === undefined) {
			await mkdir(dirname(path), { recursive: true });
			path = join(await realpath(dirname(path)), "schedules.json");
			releaseLease = await lockfile.lock(path, {
				realpath: false,
				retries: 0,
				stale: 10_000,
				update: 2_000,
				onCompromised(error) {
					leaseError = error;
					problem = `Schedules ownership was lost: ${describe(error)}`;
					publish(BACKGROUND_CONTEXT);
					options.onCompromised(error);
				},
			});
			// A replaced host may have settled its final prompt after this instance's read-only activation.
			if ((await read()) !== contents) await load(context);
			if (problem !== null) {
				await releaseLease();
				releaseLease = undefined;
			}
		}
		if (problem !== null) throw new Error(problem);
	};
	const requireCurrentFile = async (context: Context): Promise<void> => {
		if (problem !== null) throw new Error(problem);
		try {
			if ((await read()) !== contents) throw new Error("Schedules file changed. Reload it before making changes.");
		} catch (error) {
			problem = describe(error);
			publish(context);
			throw error;
		}
	};
	const commit = async (next: ScheduleRecord[], context: Context): Promise<void> => {
		await requireCurrentFile(context);
		const text = `${JSON.stringify({ version: 2, hostId, schedules: next }, null, "\t")}\n`;
		const temporary = `${path}.${randomUUID()}.tmp`;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(text, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			await rename(temporary, path);
			const directory = await open(dirname(path), "r");
			try {
				await directory.sync();
			} finally {
				await directory.close();
			}
		} finally {
			await rm(temporary, { force: true });
		}
		contents = text;
		schedules = next;
		publish(context);
	};
	const find = (id: string): ScheduleRecord | undefined => schedules.find((record) => record.id === id);
	const update = async (
		id: string,
		change: (record: ScheduleRecord) => ScheduleRecord,
		context: Context,
	): Promise<void> => {
		await commit(
			schedules.map((record) => (record.id === id ? change(record) : record)),
			context,
		);
	};
	return {
		get path() {
			return path;
		},
		get problem() {
			return problem;
		},
		get owned(): boolean {
			return releaseLease !== undefined && leaseError === undefined;
		},
		get schedules(): readonly ScheduleRecord[] {
			return schedules;
		},
		load,
		own,
		check: requireCurrentFile,
		commit,
		find,
		update,
		activate(context: Context) {
			if (path.length === 0) {
				path = join(options.agentDir(), "schedules.json");
				hostId = options.hostId();
			}
			return load(context);
		},
		close: () => releaseLease?.() ?? Promise.resolve(),
	};
}
