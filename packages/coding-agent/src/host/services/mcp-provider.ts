import { defineFacet, type Facet } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { McpManagement } from "../../core/mcp/management.ts";
import { Mcp } from "./mcp.ts";

/** This replica projects the session's connection owner; it never creates connections or stores credentials. */
export function createMcpFacet(manager: McpManagement): Facet {
	return defineFacet({
		id: "@amazme/mcp-runtime",
		setup(env) {
			const state = env.replicatedState(manager.snapshot());
			env.own(
				manager.subscribe(() => state.change(BACKGROUND_CONTEXT, (draft) => Object.assign(draft, manager.snapshot()))),
			);
			env.provide(Mcp, {
				state,
				reload: (context) => manager.reload(context),
				reconnect: (name, context) => manager.reconnect(name, context),
				configure: (name, patch, inProject, context) => manager.configure(name, patch, inProject, context),
				startLogin: (name, context) => manager.startLogin(name, context),
				submitRedirect: (id, url, context) => manager.submitRedirect(id, url, context),
				cancelLogin: (id, context) => {
					context.abortSignal?.throwIfAborted();
					return manager.cancelLogin(id);
				},
			});
		},
	});
}
