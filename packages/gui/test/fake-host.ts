import { EventEmitter } from "node:events";
import type { HostChild } from "../src/host.ts";

export interface FakeHost {
	readonly child: HostChild;
	emitStdout(chunk: string): void;
	emitStderr(chunk: string): void;
	emitExit(code: number | null, signal: NodeJS.Signals | null): void;
	emitError(error: Error): void;
	readonly kills: string[];
}

export function fakeHost(): FakeHost {
	const stdout = new EventEmitter();
	const stderr = new EventEmitter();
	const events = new EventEmitter();
	const kills: string[] = [];
	const child: HostChild = {
		stdout: {
			onData(listener) {
				stdout.on("data", listener);
				return () => {
					stdout.off("data", listener);
				};
			},
		},
		stderr: {
			onData(listener) {
				stderr.on("data", listener);
				return () => {
					stderr.off("data", listener);
				};
			},
		},
		onExit(listener) {
			events.on("exit", listener);
			return () => {
				events.off("exit", listener);
			};
		},
		onError(listener) {
			events.on("error", listener);
			return () => {
				events.off("error", listener);
			};
		},
		kill(signal) {
			kills.push(signal);
		},
	};
	return {
		child,
		emitStdout: (chunk) => {
			stdout.emit("data", chunk);
		},
		emitStderr: (chunk) => {
			stderr.emit("data", chunk);
		},
		emitExit: (code, signal) => {
			events.emit("exit", code, signal);
		},
		emitError: (error) => {
			events.emit("error", error);
		},
		kills,
	};
}
