import { APP_NAME } from "../config.ts";

/** The commands the native presentation owns; plugins cannot shadow them. */
export const NATIVE_COMMANDS = [
	{ name: "model", description: "Select the model", argumentHint: "[provider/model]" },
	{ name: "thinking", description: "Select reasoning effort", argumentHint: "[level]" },
	{ name: "scoped_models", description: "Choose models shown in /model and model cycling" },
	{ name: "attachments", description: "Remove draft image attachments" },
	{ name: "login", description: "Sign in to a model provider", argumentHint: "[provider]" },
	{ name: "logout", description: "Remove saved provider credentials", argumentHint: "[provider]" },
	{ name: "mcp", description: "Manage MCP servers" },
	{ name: "tasks", description: "Show or hide active tasks" },
	{ name: "changes", description: "Review files changed during the latest turn", argumentHint: "[file]" },
	{ name: "limits", description: "Show or set per-conversation turn budgets (0 disables)", argumentHint: "[calls seconds USD]" },
	{ name: "resume-run", description: "Continue a budget-paused turn with another budget" },
	{ name: "execution", description: "Select Unix file-write isolation", argumentHint: "[full-access|workspace-write|read-only]" },
	{ name: "agents", description: "Switch conversations" },
	{ name: "tree", description: "Navigate conversation history" },
	{ name: "fork", description: "Fork the current conversation" },
	{ name: "older", description: "Load older history" },
	{ name: "compact", description: "Compact the conversation", argumentHint: "[instructions]" },
	{ name: "share", description: "Share this session (Radius or private gist)" },
	{ name: "session", description: "Show session usage and cache waste" },
	{ name: "bug", description: "Export or upload a bug report", argumentHint: "[description]" },
	{ name: "plugins", description: "Show selected plugin sources and API" },
	{ name: "reload", description: "Reload prompt resources and selected plugins" },
	{ name: "quit", description: `Quit ${APP_NAME}` },
] as const;
