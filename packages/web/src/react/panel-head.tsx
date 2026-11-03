import type { Locale } from "../locale.ts";
import type { PanelAction, PanelSpec } from "../panels.ts";
import { PanelButtonView, SensitiveText } from "./management-fields.tsx";

/**
 * The head both panel surfaces share: the title, its description, and the panel actions. A panel
 * that the dock's tab already names passes an empty title; the head then renders only the rest.
 */
export function PanelHead({
	panel,
	locale,
	onAction,
}: {
	readonly panel: PanelSpec;
	readonly locale: Locale;
	readonly onAction: (action: PanelAction) => void;
}) {
	const actions = panel.actions ?? [];
	return (
		<header className="panel-head">
			<div className="panel-titles">
				{panel.title.length === 0 ? null : (
					<h1 className="panel-title">
						<SensitiveText text={panel.title} locale={locale} />
					</h1>
				)}
				{panel.description === undefined ? null : (
					<p className="panel-desc">
						<SensitiveText text={panel.description} locale={locale} />
					</p>
				)}
			</div>
			{actions.length === 0 ? null : (
				<div className="panel-actions">
					{actions.map((action) => (
						<PanelButtonView
							key={`${action.id}\u0000${action.data ?? ""}`}
							action={action}
							pending={panel.pending}
							onAction={onAction}
						/>
					))}
				</div>
			)}
		</header>
	);
}
