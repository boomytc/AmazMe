import assert from "node:assert/strict";
import { Type } from "typebox";
import { it } from "vitest";
import { createHost, type Facet, memoryLinkPair, method, remote } from "../src/index.ts";

for (const linked of [false, true]) {
	it(`uses each variant's method arity, including calls before ready (linked=${linked})`, async () => {
		const Value = remote("test.variant-arity", {
			version: 1,
			input: Type.Object({ takesArgs: Type.Boolean() }),
			variants: {
				empty: { methods: { read: method(undefined, Type.String()) } },
				argument: { methods: { read: method(Type.String(), Type.String()) } },
			},
		});
		const server = createHost({ name: "server" });
		const client = linked ? createHost({ name: "client" }) : server;
		if (linked) {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal: {}, kind: "host", name: client.name });
			client.connect(up);
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
			const argument = client.get(Value, { takesArgs: true }, linked ? { at: server.name } : undefined);
			const empty = client.get(Value, { takesArgs: false }, linked ? { at: server.name } : undefined);
			assert.equal(await argument.read("pending"), "pending:string");
			assert.equal(await client.root((ctx) => empty.read(ctx)), "empty:string");
			assert.equal(await client.root((ctx) => argument.read("ready", ctx)), "ready:string");
			if (!linked) {
				const cached = argument.read;
				await server.reload([facet(true)]);
				assert.equal(await cached(), "empty:string");
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
			variants: { main: { methods: { read: method(undefined, Type.String()) } } },
		});
		const Consumer = remote("test.void-consumer", {
			version: 1,
			input: Type.Object({}),
			variants: { main: { methods: { read: method() } } },
		});
		const server = createHost({ name: "server" });
		const client = linked ? createHost({ name: "client" }) : server;
		if (linked) {
			const [down, up] = memoryLinkPair();
			server.accept(down, { principal: {}, kind: "host", name: client.name });
			client.connect(up);
		}
		server.serve(Provider, () => ({ variant: "main", read: () => "discarded" }));
		try {
			const ref = client.get(Consumer, {}, linked ? { at: server.name } : undefined);
			assert.equal(await ref.read(), undefined);
		} finally {
			if (linked) await client.close();
			await server.close();
		}
	});
}
