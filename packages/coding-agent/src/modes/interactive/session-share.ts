import { hyperlink, type Container, type EditorComponent, type TUI } from "@amazme/tui";
import type { AgentSession } from "../../core/agent-session.ts";
import {
	createShareTrailingEntries,
	exportSessionForShare,
	shareSessionToUrl,
} from "../../core/session-share.ts";
import { BorderedLoader } from "./components/bordered-loader.ts";
import { theme } from "./theme/theme.ts";

interface SessionShareContext {
	session: AgentSession;
	ui: TUI;
	editorContainer: Container;
	editor: EditorComponent;
	showStatus: (message: string) => void;
	showError: (message: string) => void;
}

export { createShareTrailingEntries, exportSessionForShare };

/** Share the current session through Radius, falling back to a private gist. */
export async function shareSession(context: SessionShareContext): Promise<void> {
	const loader = new BorderedLoader(context.ui, theme, "Preparing share...");
	context.editorContainer.clear();
	context.editorContainer.addChild(loader);
	context.ui.setFocus(loader);
	context.ui.requestRender();

	let restored = false;
	const restore = (): void => {
		if (restored) return;
		restored = true;
		loader.dispose();
		context.editorContainer.clear();
		context.editorContainer.addChild(context.editor);
		context.ui.setFocus(context.editor);
	};

	try {
		const outcome = await shareSessionToUrl({
			session: context.session,
			destination: context.session.settingsManager.getSessionShareDestination(),
			themeName: theme.name,
			signal: loader.signal,
			report: (message) => {
				loader.setMessage(message);
				context.ui.requestRender();
			},
		});
		restore();
		if (outcome.ok) {
			const share = `Share URL: ${hyperlink(outcome.url, outcome.url)}`;
			const gistUrl = outcome.gistUrl;
			context.showStatus(gistUrl === undefined ? share : `${share}\nGist: ${hyperlink(gistUrl, gistUrl)}`);
		} else if (outcome.cancelled === true) {
			context.showStatus("Share cancelled");
		} else {
			context.showError(outcome.problem);
		}
	} finally {
		restore();
	}
}
