import type { Locale } from "../locale.ts";
import type { PanelAction, PanelSpec } from "../panels.ts";
import { PanelButtonView, SensitiveText } from "./management-fields.tsx";

/**
 * The head the dock's panel shares: a title when the tab does not already name it, and the panel
 * actions. The tab is the panel's top edge, so a panel the tab names passes an empty title. Static
 * guidance rides on group and row titles as hints instead of taking a line here.
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
