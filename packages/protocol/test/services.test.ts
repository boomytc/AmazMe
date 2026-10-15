import { describe, expect, it } from "vitest";
import { createHost, memoryLinkPair, replicatedState } from "@amazme/chord";
import type { Context, ReplicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT as context } from "@amazme/chord/context";
import { createServiceHost, remoteService, serviceFacet, ServiceScope } from "../src/services.ts";

interface Counter {
	state: ReplicatedState<{ count: number }>;
	add(amount: number, context: Context): Promise<number>;
}
const Counter = remoteService<Counter>("test.counter", { add: 1 }, ["state"]);

describe("product services on Chord", () => {
	it("owns implementations and preserves references across resource reload", async () => {
		const closed: number[] = [];
		const facet = (start: number) =>
			serviceFacet("counter", Counter, [], () => {
				const state = replicatedState({ count: start });
				return {
					value: {
						state,
						async add(amount: number) {
							state.change(context, (draft) => {
								draft.count += amount;
							});
							return state.value.count;
						},
					},
					close() {
						closed.push(start);
					},
				};
			});
		const host = createServiceHost();
		const scope = new ServiceScope(host);
		try {
			await host.load([facet(1)]);
			await host.ready();
			const counter = scope.get(Counter);
			await scope.ready();
			expect(await counter.add(2, context)).toBe(3);
			await host.reload([facet(5)]);
			expect(await counter.add(2, context)).toBe(7);
			expect(closed).toEqual([1]);
		} finally {
			scope.dispose();
			await host.close();
		}
		expect(closed).toEqual([1, 5]);
	});
	it("carries methods and state across a native link", async () => {
		const server = createServiceHost("server");
		const client = createHost({ self: { client: "client" }, name: "client", kind: "client" });
		const scope = new ServiceScope(client, { host: server.name });
		try {
			await server.load([
				serviceFacet("counter", Counter, [], () => ({
					value: {
						state: replicatedState({ count: 3 }),
						async add(amount: number) {
							return amount + 3;
						},
					},
				})),
			]);
			const [left, right] = memoryLinkPair();
			server.accept(left, { principal: { id: "client" } });
			client.connect(right, { principal: { host: server.name } });
			const counter = scope.get(Counter);
			await scope.ready();
			expect(counter.state.value).toEqual({ count: 3 });
			expect(await counter.add(4, context)).toBe(7);
		} finally {
			scope.dispose();
			await client.close();
			await server.close();
		}
	});
});

import { activationFacet, serviceSetFacet } from "../src/services.ts";
it("reloads a group of stateful surfaces with a host-owned dependent", async () => {
	const host = createServiceHost();
	const scope = new ServiceScope(host);
	const facet = (value: number) =>
		serviceSetFacet("group", [Counter], [], async () => ({
			value: new Map([
				[Counter, { state: replicatedState({ count: value }), add: async (amount: number) => amount + value }],
			]),
		}));
	const seen: number[] = [];
	const observer = activationFacet("observer", [Counter], (services) =>
		services.get(Counter).state.subscribe((value) => {
			seen.push(value.count);
		}),
	);
	try {
		await host.load([facet(1), observer]);
		const counter = scope.get(Counter);
		await scope.ready();
		await host.reload([facet(2)]);
		expect(await counter.add(1, context)).toBe(3);
	} finally {
		scope.dispose();
		await host.close();
	}
});

import { ChannelEndpoint, frameJson, openChannel, parseChannelFrame } from "../src/channels.ts";

it("preserves packed snapshots, arguments and results through the attachment JSON bridge", async () => {
	const Large = remoteService<{ state: ReplicatedState<{ text: string }>; echo(value: string, context: Context): Promise<string> }>(
		"test.large", { echo: 1 }, ["state"],
	);
	const text = "large payload ".repeat(20_000);
	const server = createServiceHost("large-server");
	const endpoint = new ChannelEndpoint(server, () => []);
	const client = createHost({ self: { client: globalThis.crypto.randomUUID() }, kind: "client" });
	const scope = new ServiceScope(client, { host: server.name });
	try {
		await server.load([serviceFacet("large", Large, [], () => ({ value: {
			state: replicatedState({ text }), echo: async value => value,
		} }))]);
		const channel = await openChannel((call, publish, ctx) => endpoint.invoke(call,
			(name, frame, context) => publish(name, frame === undefined ? undefined : parseChannelFrame(frameJson(frame)), context), ctx), context);
		client.connect(channel.link, { principal: { host: channel.host } });
		const large = scope.get(Large);
		await scope.ready();
		expect(large.state.value?.text).toBe(text);
		expect(await large.echo(text, context)).toBe(text);
		await channel.close();
	} finally {
		scope.dispose();
		await client.close();
		await endpoint.dispose();
		await server.close();
	}
});
it("isolates identical channel names across attachments and joins cancelled call cleanup", async () => {
	const Pending = remoteService<{ wait(context: Context): Promise<void> }>("test.pending", { wait: 0 });
	const server = createServiceHost("server");
	let started = 0;
	let aborted = 0;
	let finishCleanup!: () => void;
	const cleanup = new Promise<void>((resolve) => {
		finishCleanup = resolve;
	});
	await server.load([
		serviceFacet("pending", Pending, [], () => ({
			value: {
				async wait(ctx: Context) {
					started++;
					await new Promise<void>((resolve) =>
						ctx.abortSignal!.addEventListener("abort", () => resolve(), { once: true }),
					);
					aborted++;
					await cleanup;
					throw ctx.abortSignal!.reason;
				},
			},
		})),
	]);
	const peers = await Promise.all(
		[0, 1].map(async () => {
			const endpoint = new ChannelEndpoint(server, () => []);
			const connection = await openChannel(
				(call, publish, ctx) =>
					endpoint.invoke(call.kind === "catalogue" ? call : { ...call, channel: "same" }, publish, ctx),
				context,
			);
			const host = createHost({ self: { client: globalThis.crypto.randomUUID() }, kind: "client" });
			host.connect(connection.link, { principal: { host: connection.host } });
			const scope = new ServiceScope(host, { host: connection.host });
			const pending = scope.get(Pending);
			await scope.ready();
			return { endpoint, connection, host, scope, result: pending.wait(context).catch(() => {}) };
		}),
	);
	try {
		await expect.poll(() => started).toBe(2);
		let closed = false;
		const closing = peers[0]!.endpoint.dispose().then(() => {
			closed = true;
		});
		await expect.poll(() => aborted).toBe(1);
		expect(closed).toBe(false);
		finishCleanup();
		await closing;
		expect(aborted).toBe(1);
	} finally {
		finishCleanup();
		for (const peer of peers) {
			peer.scope.dispose();
			await peer.host.close();
			await peer.endpoint.dispose();
			await peer.result;
		}
		await server.close();
	}
});

it("bounds slow state subscribers while delivering the latest revision", async () => {
	const state = replicatedState({ count: 0 });
	const host = createServiceHost();
	const scope = new ServiceScope(host);
	let release!: () => void;
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const seen: number[] = [];
	try {
		await host.load([
			serviceFacet("counter", Counter, [], () => ({
				value: {
					state,
					async add(amount: number) {
						return amount;
					},
				},
			})),
		]);
		const counter = scope.get(Counter);
		await scope.ready();
		const stop = counter.state.subscribe(async (value) => {
			seen.push(value.count);
			if (value.count === 0) await blocked;
		});
		for (let count = 1; count <= 1000; count++) state.replace(context, { count });
		release();
		await expect.poll(() => seen.at(-1)).toBe(1000);
		expect(seen.length).toBeLessThanOrEqual(101);
		stop();
	} finally {
		release();
		scope.dispose();
		await host.close();
	}
});
