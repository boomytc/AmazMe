/** The commands the native presentation owns; plugins cannot shadow them. */
export const NATIVE_COMMANDS = [
	{ name: "model", description: "Select the model" },
	{ name: "login", description: "Sign in to a model provider", argumentHint: "[provider]" },
	{ name: "logout", description: "Remove saved provider credentials", argumentHint: "[provider]" },
	{ name: "mcp", description: "Manage MCP servers" },
	{ name: "tasks", description: "Show or hide active tasks" },
	{ name: "agents", description: "Switch conversations" },
	{ name: "tree", description: "Navigate conversation history" },
	{ name: "fork", description: "Fork the current conversation" },
	{ name: "older", description: "Load older history" },
	{ name: "compact", description: "Compact the conversation", argumentHint: "[instructions]" },
	{ name: "plugins", description: "Show selected plugin sources and API" },
	{ name: "reload", description: "Reload prompt resources and selected plugins" },
] as const;
