import { defineService, type Context, type ReplicatedState } from "@amazme/chord";
import type { McpManagementState } from "../../core/mcp/management.ts";
import type { McpServerConfigPatch } from "../../extensions/mcp/config.ts";

export interface Mcp {
	readonly state: ReplicatedState<McpManagementState>;
	reload(context: Context): Promise<void>;
	reconnect(name: string, context: Context): Promise<void>;
	configure(name: string, patch: McpServerConfigPatch, inProject: boolean, context: Context): Promise<void>;
	startLogin(name: string, context: Context): Promise<string>;
	submitRedirect(id: string, url: string, context: Context): Promise<boolean>;
	cancelLogin(id: string, context: Context): Promise<boolean>;
}

export const Mcp = defineService<Mcp>("amazme.mcp");
