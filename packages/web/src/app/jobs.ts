/// <reference lib="dom" />
/**
 * The attached session's background jobs: the list the host keeps, one job's paged output, and the
 * stop request. The host owns execution and retention; this controller only reads and asks.
 */
import type { JobList, JobOutputView, JobView } from "../generated/contracts.ts";
import type { ClientConnection, PythonClient } from "../transport/client.ts";

export type JobStream = "stdout" | "stderr";

export interface JobOutputState {
	readonly jobId: string;
	readonly stream: JobStream;
	readonly content: string;
	readonly nextOffset: number;
	readonly hasMore: boolean;
	readonly error?: string;
	readonly waitReason?: string;
}

export interface JobsState {
	readonly jobs: readonly JobView[];
	readonly truncated: boolean;
	readonly selected?: string;
	readonly output?: JobOutputState;
}

interface JobsServices {
	readonly client: PythonClient;
	readonly connection: () => ClientConnection;
	readonly changed: () => void;
	readonly error: (error: unknown) => void;
}

export class Jobs {
	state?: JobsState;
	private listGeneration = 0;
	private outputGeneration = 0;
	private readonly services: JobsServices;
	constructor(services: JobsServices) {
		this.services = services;
	}
	reset(): void {
		this.listGeneration++;
		this.outputGeneration++;
		this.state = undefined;
	}
	/** Re-read the list; a selected job stays visible only while the host still lists it. */
	async load(): Promise<void> {
		const connection = this.services.connection();
		if (!connection.active()) return;
		const generation = ++this.listGeneration;
		const list: JobList = await this.services.client.call(
			"GET /api/v1/sessions/{session_id}/jobs",
			{ path: { session_id: connection.sessionId } },
		);
		if (!connection.active() || generation !== this.listGeneration) return;
		const selected =
			this.state?.selected &&
			list.jobs.some((job) => job.job_id === this.state?.selected)
				? this.state.selected
				: undefined;
		this.state = {
			jobs: list.jobs,
			truncated: list.truncated === true,
			...(selected === undefined ? {} : { selected }),
			...(selected === undefined ? {} : { output: this.state?.output }),
		};
		this.services.changed();
	}
	async select(jobId: string): Promise<void> {
		if (!this.state?.jobs.some((job) => job.job_id === jobId))
			throw new Error("作业不存在");
		this.state = { ...this.state, selected: jobId, output: undefined };
		await this.readOutput(jobId, "stdout", 0, false);
	}
	async setStream(stream: JobStream): Promise<void> {
		const jobId = this.state?.selected;
		if (jobId === undefined) return;
		await this.readOutput(jobId, stream, 0, false);
	}
	async loadMore(): Promise<void> {
		const output = this.state?.output;
		if (output === undefined || !output.hasMore) return;
		await this.readOutput(output.jobId, output.stream, output.nextOffset, true);
	}
	closeOutput(): void {
		if (this.state === undefined) return;
		this.outputGeneration++;
		this.state = { jobs: this.state.jobs, truncated: this.state.truncated };
		this.services.changed();
	}
	async kill(jobId: string): Promise<void> {
		const connection = this.services.connection();
		if (!connection.active()) return;
		await this.services.client.call(
			"POST /api/v1/sessions/{session_id}/jobs/{job_id}/kill",
			{ path: { session_id: connection.sessionId, job_id: jobId }, connection },
		);
		if (!connection.active()) return;
		await this.load();
		if (this.state?.selected === jobId) await this.readOutput(jobId, this.state.output?.stream ?? "stdout", 0, false);
	}
	private async readOutput(jobId: string, stream: JobStream, offset: number, append: boolean): Promise<void> {
		const connection = this.services.connection();
		if (!connection.active()) return;
		const generation = ++this.outputGeneration;
		const view: JobOutputView = await this.services.client.call(
			"GET /api/v1/sessions/{session_id}/jobs/{job_id}/output",
			{
				path: { session_id: connection.sessionId, job_id: jobId },
				query: { stream, offset },
			},
		);
		if (!connection.active() || generation !== this.outputGeneration) return;
		const page = view.output;
		const content = page === null || page === undefined
			? ""
			: append
				? `${this.state?.output?.content ?? ""}${page.content}`
				: page.content;
		this.state = {
			...(this.state ?? { jobs: [], truncated: false }),
			selected: jobId,
			output: {
				jobId,
				stream,
				content,
				nextOffset: page?.next_offset ?? offset,
				hasMore: page?.has_more === true,
				...(view.error ? { error: view.error } : {}),
				...(view.wait_reason ? { waitReason: view.wait_reason } : {}),
			},
		};
		this.services.changed();
	}
}
