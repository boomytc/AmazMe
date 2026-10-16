import assert from "node:assert/strict";
import { Type } from "typebox";
import { it } from "vitest";
import {
	createHost,
	type Ctx,
	type Host,
	hostNamed,
	isChordError,
	local,
	memoryLinkPair,
	method,
	remote,
} from "../src/index.ts";
import { CountingLink } from "./fixtures/counting.ts";

const Payload = Type.Object({ rootId: Type.String(), signal: Type.String() });
const payload = { rootId: "ordinary argument", signal: "not a context" };
const Target = remote("test.pending-call-context", {
	version: 1,
	input: Type.Object({}),
	host: hostNamed("server"),
	variants: {
		main: {
			methods: {
				hit: method(),
				echo: method(Payload, Type.String()),
			},
		},
	},
});
const Mixed = remote("test.pending-call-context-mixed", {
	version: 1,
	input: Type.Object({ takesArgs: Type.Boolean() }),
	host: hostNamed("server"),
	variants: {
		empty: { methods: { read: method(undefined, Type.String()) } },
		argument: { methods: { read: method(Payload, Type.String()) } },
	},
});
const Runner = local("test.pending-call-context-runner", {
	version: 1,
	input: Type.Object({}),
});

function latch<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

async function ticks(): Promise<void> {
	for (let i = 0; i < 10; i++)
		await new Promise<void>((resolve) => setImmediate(resolve));
}

async function holder(
	host: Host,
	expire: boolean,
): Promise<{ ctx: Ctx; close(): void }> {
	const started = latch<Ctx>();
	const done = latch();
	host.serve(Runner, (_input, _principal, self) => {
		self.task(async (ctx) => {
			started.resolve(ctx);
			if (!expire) await done.promise;
		});
		return {};
	});
	const ref = host.hold(Runner, {});
	await ref.ready;
	const ctx = await started.promise;
	await ticks();
	return {
		ctx,
		close: () => {
			done.resolve();
			ref.release();
		},
	};
}

function setup(linked: boolean) {
	const gate = latch();
	const server = createHost({ self: {}, name: "server", onError: () => {} });
	const client = linked
		? createHost({ self: {}, name: "client", onError: () => {} })
		: server;
	const other = createHost({ self: {}, name: "other", onError: () => {} });
	let link: CountingLink | undefined;
	if (linked) {
		const [down, up] = memoryLinkPair();
		link = new CountingLink(up);
		server.accept(down, { kind: "host", name: "client", principal: {} });
		client.connect(link, { principal: {} });
	}
	let hits = 0;
	server.serve(Target, (_input, _principal, self) => {
		self.resource("gate", { version: 1, open: () => gate.promise });
		return {
			variant: "main",
			hit: () => {
				hits++;
			},
			echo: (value) => {
				hits++;
				return value.rootId;
			},
		};
	});
	server.serve(Mixed, ({ takesArgs }, _principal, self) => {
		self.resource("gate", { version: 1, open: () => gate.promise });
		return takesArgs
			? { variant: "argument", read: (value) => value.rootId }
			: { variant: "empty", read: () => "empty" };
	});
	return {
		client,
		other,
		gate,
		link,
		hits: () => hits,
		async close() {
			gate.resolve();
			if (linked) await client.close();
			await server.close();
			await other.close();
		},
	};
}

for (const linked of [false, true]) {
	for (const kind of [
		"forged",
		"foreign",
		"foreign-holder",
		"expired-holder",
	] as const) {
		it(`rejects ${kind} contexts before hydration (linked=${linked})`, async () => {
			const fixture = setup(linked);
			const { client, other, gate } = fixture;
			const ref = client.hold(Target, {});
			const task = kind.endsWith("holder")
				? await holder(
						kind === "foreign-holder" ? other : client,
						kind === "expired-holder",
					)
				: undefined;
			const ctx =
				task?.ctx ??
				(kind === "foreign"
					? await other.root((ctx) => ctx)
					: ({
							rootId: "forged",
							codeVersion: 1,
							signal: new AbortController().signal,
						} as unknown as Ctx));
			const outcomes: unknown[] = [];
			const calls = [ref.hit(ctx), ref.echo(payload, ctx)].map((call, index) =>
				call.then(
					() => {
						outcomes[index] = "called";
					},
					(error: unknown) => {
						outcomes[index] = error;
					},
				),
			);
			try {
				await ticks();
				assert.equal(ref.status, "loading");
				for (const index of [0, 1]) {
					const error = outcomes[index];
					assert.ok(
						isChordError(
							error,
							kind === "expired-holder" ? "aborted" : "invalid",
						),
						`call ${index} did not reject before hydration`,
					);
					assert.equal(
						error.reason,
						kind === "expired-holder" ? "expired" : "foreign_ctx",
					);
				}
				assert.equal(fixture.hits(), 0);
				assert.equal(fixture.link?.count("sent", "call") ?? 0, 0);
			} finally {
				gate.resolve();
				await Promise.all(calls);
				task?.close();
				ref.release();
				await fixture.close();
			}
		});
	}

	it(`accepts a live holder across fixed and mixed method arities (linked=${linked})`, async () => {
		const fixture = setup(linked);
		const ref = fixture.client.hold(Target, {});
		const task = await holder(fixture.client, false);
		const argument = fixture.client.hold(Mixed, { takesArgs: true });
		const empty = fixture.client.hold(Mixed, { takesArgs: false });
		const readArgument = Reflect.get(argument, "read") as (
			value: typeof payload,
			ctx?: Ctx,
		) => Promise<string>;
		const readEmpty = Reflect.get(empty, "read") as (
			ctx?: Ctx,
		) => Promise<string>;
		const calls = Promise.all([
			ref.hit(task.ctx),
			ref.echo(payload, task.ctx),
			readArgument(payload, task.ctx),
			readEmpty(task.ctx),
		]);
		try {
			await ticks();
			assert.equal(fixture.hits(), 0);
			fixture.gate.resolve();
			assert.deepEqual(await calls, [
				undefined,
				payload.rootId,
				payload.rootId,
				"empty",
			]);
		} finally {
			fixture.gate.resolve();
			await calls;
			task.close();
			ref.release();
			argument.release();
			empty.release();
			await fixture.close();
		}
	});

	it(`keeps legitimate object arguments and holder cancellation before hydration (linked=${linked})`, async () => {
		const fixture = setup(linked);
		const ref = fixture.client.hold(Target, {});
		const task = await holder(fixture.client, false);
		const mixedArgument = fixture.client.hold(Mixed, { takesArgs: true });
		const mixedEmpty = fixture.client.hold(Mixed, { takesArgs: false });
		const readArgument = Reflect.get(mixedArgument, "read") as (
			value: typeof payload,
			ctx?: Ctx,
		) => Promise<string>;
		const readEmpty = Reflect.get(mixedEmpty, "read") as (
			ctx?: Ctx,
		) => Promise<string>;
		const calls = [
			ref.echo(payload),
			readArgument(payload),
			readArgument(payload, task.ctx),
			readEmpty(task.ctx),
		];
		const settled = Promise.allSettled(calls);
		let cancelled: unknown;
		const cancelledCall = ref.hit(task.ctx).catch((error: unknown) => {
			cancelled = error;
		});
		try {
			await ticks();
			assert.equal(ref.status, "loading");
			// Releasing the holder must abort its waiting call without opening the hydration gate.
			task.close();
			await cancelledCall;
			assert.ok(isChordError(cancelled, "aborted"));
			assert.equal(fixture.hits(), 0);
			fixture.gate.resolve();
			const results = await settled;
			assert.deepEqual(results.slice(0, 2), [
				{ status: "fulfilled", value: payload.rootId },
				{ status: "fulfilled", value: payload.rootId },
			]);
			assert.ok(
				results
					.slice(2)
					.every(
						(result) =>
							result.status === "rejected" &&
							isChordError(result.reason, "aborted"),
					),
			);
		} finally {
			fixture.gate.resolve();
			await Promise.allSettled(calls);
			task.close();
			ref.release();
			mixedArgument.release();
			mixedEmpty.release();
			await fixture.close();
		}
	});
}
