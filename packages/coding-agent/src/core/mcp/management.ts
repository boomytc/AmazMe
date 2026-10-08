import type { Context } from "@amazme/chord";
import type { McpExposure } from "../mcp-servers.ts";
import type { McpServerConfigPatch } from "../../extensions/mcp/config.ts";
import type { McpServerConnection } from "../../extensions/mcp/runtime.ts";

export interface McpServerStatus {
	name: string;
	enabled: boolean;
	exposure: McpExposure;
	state: "disabled" | McpServerConnection["state"];
	transport: "stdio" | "http";
	tools: number;
	resources: number;
	templates: number;
	scope: "global" | "project";
	canLogin: boolean;
	error: string | null;
}

export interface McpLoginState {
	id: string;
	server: string;
	status: "preparing" | "awaiting" | "finishing" | "done" | "cancelled" | "error";
	url: string | null;
	error: string | null;
}

export interface McpManagementState {
	revision: number;
	disabled: boolean;
	canOverrideProject: boolean;
	errors: string[];
	servers: McpServerStatus[];
	login: McpLoginState | null;
}

/** A data-only control surface, also used by the hosted service. Credentials remain in the connection owner. */
export interface McpManagement {
	snapshot(): McpManagementState;
	subscribe(listener: () => void): () => void;
	reload(context: Context): Promise<void>;
	reconnect(name: string, context: Context): Promise<void>;
	configure(name: string, patch: McpServerConfigPatch, inProject: boolean, context: Context): Promise<void>;
	startLogin(name: string, context: Context): Promise<string>;
	submitRedirect(id: string, url: string, context: Context): Promise<boolean>;
	cancelLogin(id: string): Promise<boolean>;
}
