/** SDK mounting for the shared MCP manager view. */
import type { ExtensionCommandContext } from "../../core/extensions/types.ts";
import { McpManagerView, type McpUi } from "../../core/mcp/view.ts";
export { McpManagerView } from "../../core/mcp/view.ts";
export type { McpMenu, McpUi } from "../../core/mcp/view.ts";

/** Run `manage` in the manager view until it returns. */
export async function showMcpManager(
	ctx: ExtensionCommandContext,
	manage: (ui: McpUi) => Promise<void>,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, keybindings, done) => {
		const view = new McpManagerView(tui, theme, keybindings);
		void manage(view).then(
			() => done(),
			(error: unknown) => {
				ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				done();
			},
		);
		return view;
	});
}
