import { serviceFacet, type ServiceValue, disposeResources } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import { type Facet } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import type { McpManagement } from "../../core/mcp/management.ts";
import { Mcp } from "./mcp.ts";

/** This replica projects the session's connection owner; it never creates connections or stores credentials. */
export function createMcpFacet(manager: McpManagement): Facet {
	return serviceFacet("@amazme/mcp-runtime", Mcp, [], async (services) => {
		const disposers: Array<() => void | Promise<void>> = [];
		try {
			const state = replicatedState(manager.snapshot());
			disposers.push(
				manager.subscribe(() => state.change(BACKGROUND_CONTEXT, (draft) => Object.assign(draft, manager.snapshot()))),
			);
			const implementation: ServiceValue<typeof Mcp> = {
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
			};

			return { value: implementation, close: () => disposeResources(disposers) };
		} catch (error) {
			await disposeResources(disposers);
			throw error;
		}
	});
}
