/**
 * Native facet plugins.
 *
 * Pass facet files or packages with `extensions`. Inline `ctx.ui` factories are not part of the SDK.
 * `-e` on the CLI selects the same kind of source.
 */

import { createDurableSession } from "@amazme/coding-agent";

const session = await createDurableSession({
	extensions: ["./my-facet.ts"],
	noSession: true,
});

try {
	await session.prompt("What plugins are loaded?");
} finally {
	await session.dispose();
}
