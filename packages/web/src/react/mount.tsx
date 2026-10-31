import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App, StartupBoundary } from "./app.tsx";
import type { Presentation } from "./state.ts";

const owners = new WeakSet<HTMLElement>();

export function mountPresentation(
	presentation: Presentation,
	container: HTMLElement,
): void {
	if (owners.has(container)) throw new Error("页面容器已经挂载");
	const root = createRoot(container);
	owners.add(container);
	presentation.attach(() => {
		root.unmount();
		owners.delete(container);
	});
	root.render(
		<StrictMode>
			<StartupBoundary>
				<App presentation={presentation} />
			</StartupBoundary>
		</StrictMode>,
	);
}
