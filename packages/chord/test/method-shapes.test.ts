import assert from "node:assert/strict";
import { Type } from "typebox";
import { it } from "vitest";
import { createHost, type Ctx, type Facet, hostNamed, memoryLinkPair, method, remote } from "../src/index.ts";

for (const linked of [false, true]) {
	it(`uses each variant's method arity, including calls before ready (linked=${linked})`, async () => {
		const Value = remote("test.variant-arity", {
			version: 1,
			input: Type.Object({ takesArgs: Type.Boolean() }),
			host: hostNamed("server"),
			variants: {
				empty: { methods: { read: method(undefined, Type.String()) } },
				argument: { methods: { read: method(Type.String(), Type.String()) } },
			},
		});
		const server = createHost({ self: { host: "server" }, name: "server" });
		const client = linked ? createHost({ self: { host: "client" }, name: "client" }) : server;
		if (linked) {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal: {}, kind: "host", name: client.name });
			client.connect(up, { principal: { host: server.name } });
		}
		const facet = (flipped = false): Facet => ({
			name: "value",
			setup: (api) =>
				api.serve(Value, ({ takesArgs }) =>
					takesArgs && !flipped
						? { variant: "argument", read: (text, ctx) => `${text}:${typeof ctx.rootId}` }
						: { variant: "empty", read: (ctx) => `empty:${typeof ctx.rootId}` },
				),
		});
		await server.load([facet()]);
		try {
			const argument = client.hold(Value, { takesArgs: true });
			const empty = client.hold(Value, { takesArgs: false });
			const readArgument = Reflect.get(argument, "read") as (text?: string, ctx?: Ctx) => Promise<string>;
			const readEmpty = Reflect.get(empty, "read") as (ctx?: Ctx) => Promise<string>;
			assert.equal(await readArgument("pending"), "pending:string");
			assert.equal(await client.root((ctx) => readEmpty(ctx)), "empty:string");
			assert.equal(await client.root((ctx) => readArgument("ready", ctx)), "ready:string");
			if (!linked) {
				await server.reload([facet(true)]);
				assert.equal(await readArgument(), "empty:string");
			}
		} finally {
			if (linked) await client.close();
			await server.close();
		}
	});

	it(`discards the provider's result when the consumer declares void (linked=${linked})`, async () => {
		const Provider = remote("test.void-consumer", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { methods: { read: method(undefined, Type.String()) } } },
		});
		const Consumer = remote("test.void-consumer", {
			version: 1,
			input: Type.Object({}),
			host: hostNamed("server"),
			variants: { main: { methods: { read: method() } } },
		});
		const server = createHost({ self: { host: "server" }, name: "server" });
		const client = linked ? createHost({ self: { host: "client" }, name: "client" }) : server;
		if (linked) {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal: {}, kind: "host", name: client.name });
			client.connect(up, { principal: { host: server.name } });
		}
		server.serve(Provider, () => ({ variant: "main", read: () => "discarded" }));
		try {
			const ref = await client.get(Consumer, {});
			assert.equal(await ref.read(), undefined);
		} finally {
			if (linked) await client.close();
			await server.close();
		}
	});
}
