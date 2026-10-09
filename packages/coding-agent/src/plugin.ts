/** Agent contributions use Chord facets and the application's existing Durable registry. */
export { AgentExtensions, type AgentExtensionInfo } from "./core/plugins/agent-extensions.ts";
export {
	AgentController,
	type AgentPromptRequest,
	type AgentPromptResult,
	type AgentOperationResponse,
	type AgentQueueResponse,
	type AgentOperationError,
	type AgentCompactionRequest,
} from "./core/plugins/agent-controller.ts";
export {
	SlashCommands,
	type SlashCommandCompletion,
	type SlashCommandContribution,
	type SlashCommandRunResult,
} from "./core/plugins/slash-commands.ts";
