import type { KeyboardEvent, SyntheticEvent } from "react";
import {
	Fragment,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import { MODEL_CONNECTIONS_ACTION, MODEL_SCOPE_ACTION } from "../actions.ts";
import type { PageRenderer } from "../render.ts";
import { translate } from "../strings.ts";
import { USAGE_ACTION } from "../usage.ts";
import type { ModelOption } from "../view.ts";
import type { ComposerView } from "./chat.tsx";

const RECENT_KEY = "amazme.recent-models";
const RECENT_STORED = 6;
const RECENT_SHOWN = 4;
const RECENT_MIN_OPTIONS = 7;

type IconName = "check" | "chevron-down" | "search" | "sliders";

function Icon({
	name,
	className = "icon",
}: {
	readonly name: IconName;
	readonly className?: string;
}) {
	return (
		<svg
			className={className}
			viewBox="0 0 24 24"
			aria-hidden="true"
			focusable="false"
		>
			<use href={`#i-${name}`} />
		</svg>
	);
}

function command(actions: PageRenderer, id: string, data?: string): void {
	actions.onPanelAction({ kind: "command", id, data });
}

function optionKey(option: ModelOption): string {
	return JSON.stringify([option.provider, option.modelId]);
}

function readRecent(): readonly string[] {
	try {
		const stored: unknown = JSON.parse(
			localStorage.getItem(RECENT_KEY) ?? "[]",
		);
		return Array.isArray(stored)
			? stored
					.filter((value): value is string => typeof value === "string")
					.slice(0, RECENT_STORED)
			: [];
	} catch {
		return [];
	}
}

function writeRecent(recent: readonly string[]): void {
	try {
		localStorage.setItem(RECENT_KEY, JSON.stringify(recent));
	} catch {
		// The picker still works when browser storage is unavailable.
	}
}

/** The model catalog, recent choices, reasoning levels, and the route to connection management. */
export function ComposerModelControls({
	view,
	actions,
}: {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
}) {
	const model = view.model;
	const options = useMemo(
		() => model.groups.flatMap((group) => group.options),
		[model.groups],
	);
	const disabled = model.disabled || view.sessionDraft?.disabled === true;
	const scopeEmpty = model.empty === translate(view.locale, "model.scopeEmpty");
	if (options.length === 0 && model.empty !== undefined) {
		return (
			<div className="model-setup">
				{scopeEmpty ? (
					<button
						type="button"
						className="model-setup-button weight-filled"
						disabled={disabled}
						aria-busy={view.modelPending === true}
						onClick={() => command(actions, MODEL_SCOPE_ACTION)}
					>
						{translate(view.locale, "model.configureModels")}
					</button>
				) : null}
				<button
					type="button"
					className={`model-setup-button weight-${scopeEmpty ? "line" : "filled"}`}
					disabled={disabled}
					aria-busy={view.modelPending === true}
					onClick={() => command(actions, MODEL_CONNECTIONS_ACTION)}
				>
					{translate(view.locale, "model.connectProvider")}
				</button>
			</div>
		);
	}

	return (
		<ModelPicker
			view={view}
			actions={actions}
			options={options}
			disabled={disabled}
		/>
	);
}

function ModelPicker({
	view,
	actions,
	options,
	disabled,
}: {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
	readonly options: readonly ModelOption[];
	readonly disabled: boolean;
}) {
	const dialog = useRef<HTMLDialogElement>(null);
	const trigger = useRef<HTMLButtonElement>(null);
	const search = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [recent, setRecent] = useState(readRecent);
	const effort = view.model.effort;
	const title = [
		view.model.label,
		view.model.effort,
		view.model.scopeNotice,
		view.model.empty,
		view.model.refresh.status,
		translate(view.locale, "model.nextRequest"),
	]
		.filter((value): value is string => value !== undefined && value.length > 0)
		.join("\n");
	const matchingGroups = useMemo(() => {
		const needle = query.trim().toLocaleLowerCase();
		return view.model.groups
			.map((group) => ({
				...group,
				options: group.options.filter((option) =>
					`${option.label} ${option.provider} ${option.modelId}`
						.toLocaleLowerCase()
						.includes(needle),
				),
			}))
			.filter((group) => group.options.length > 0);
	}, [query, view.model.groups]);
	const matching = matchingGroups.flatMap((group) => group.options);
	const recentOptions =
		query.trim().length === 0 && options.length >= RECENT_MIN_OPTIONS
			? recent
					.flatMap((key) =>
						options.filter((option) => optionKey(option) === key),
					)
					.slice(0, RECENT_SHOWN)
			: [];
	const firstMatch = query.trim().length === 0 ? undefined : matching[0];

	useLayoutEffect(() => {
		const node = dialog.current;
		if (!open || node === null) return;
		if (!node.open) node.showModal();
		const place = () => {
			const anchor = trigger.current?.getBoundingClientRect();
			if (anchor === undefined) return;
			const ceiling =
				trigger.current?.closest("form")?.getBoundingClientRect().top ??
				anchor.top;
			node.style.right = `${Math.round(Math.max(8, Math.min(window.innerWidth - anchor.right, window.innerWidth - node.offsetWidth - 8)))}px`;
			node.style.bottom = `${Math.round(window.innerHeight - ceiling + 8)}px`;
			node.style.maxHeight = `${Math.round(Math.max(160, ceiling - 24))}px`;
		};
		place();
		search.current?.focus({ preventScroll: true });
		node
			.querySelector<HTMLButtonElement>(
				'.model-picker-option[aria-pressed="true"]',
			)
			?.scrollIntoView({ block: "nearest" });
		return () => {
			if (node.open) node.close();
		};
	}, [open]);

	const choose = (option: ModelOption) => {
		const key = optionKey(option);
		const next = [key, ...recent.filter((value) => value !== key)].slice(
			0,
			RECENT_STORED,
		);
		setRecent(next);
		writeRecent(next);
		setOpen(false);
		actions.onSelectModel(option.provider, option.modelId);
	};

	const cancel = (event: SyntheticEvent<HTMLDialogElement>) => {
		if (query.length === 0) return;
		event.preventDefault();
		setQuery("");
		search.current?.focus({ preventScroll: true });
	};

	const onKeyDown = (event: KeyboardEvent<HTMLDialogElement>) => {
		if (event.nativeEvent.isComposing) return;
		const active = document.activeElement;
		if (
			(event.key === "ArrowLeft" || event.key === "ArrowRight") &&
			active instanceof HTMLButtonElement &&
			active.closest(".model-picker-levels") !== null
		) {
			const controls = [
				...event.currentTarget.querySelectorAll<HTMLButtonElement>(
					".model-picker-level",
				),
			];
			const index = controls.indexOf(active);
			const next =
				controls[
					(index + (event.key === "ArrowRight" ? 1 : controls.length - 1)) %
						controls.length
				];
			event.preventDefault();
			next?.focus();
			next?.click();
			return;
		}
		if (event.key === "Enter" && active === search.current) {
			const first = event.currentTarget.querySelector<HTMLButtonElement>(
				".model-picker-option",
			);
			if (first !== null) {
				event.preventDefault();
				first.click();
			}
			return;
		}
		if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
		event.preventDefault();
		const rows = [
			...event.currentTarget.querySelectorAll<HTMLButtonElement>(
				".model-picker-option",
			),
		];
		const index =
			active instanceof HTMLButtonElement ? rows.indexOf(active) : -1;
		if (index < 0) {
			(event.key === "ArrowDown" ? rows[0] : rows.at(-1))?.focus();
			return;
		}
		const next = index + (event.key === "ArrowDown" ? 1 : -1);
		if (next < 0 || next >= rows.length) search.current?.focus();
		else rows[next]?.focus();
	};

	return (
		<>
			<button
				ref={trigger}
				type="button"
				className="composer-model-picker"
				disabled={disabled || options.length === 0}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-busy={view.modelPending === true}
				aria-label={`${translate(view.locale, "model.heading")}: ${[view.model.label, effort].filter(Boolean).join(", ")}`}
				title={title}
				onClick={() => {
					setQuery("");
					setOpen(true);
				}}
			>
				<span className="composer-model-name">{view.model.label}</span>
				{effort === undefined ? null : (
					<span className="composer-model-effort">{effort}</span>
				)}
				<Icon name="chevron-down" className="icon composer-model-chevron" />
			</button>
			{!open ? null : (
				<dialog
					ref={dialog}
					className="model-picker-menu"
					aria-label={translate(view.locale, "model.choose")}
					onCancel={cancel}
					onClose={() => {
						setOpen(false);
						trigger.current?.focus({ preventScroll: true });
					}}
					onKeyDown={onKeyDown}
					onClick={(event) => {
						if (event.target === event.currentTarget)
							event.currentTarget.close();
					}}
				>
					<label className="model-picker-search">
						<Icon name="search" className="icon model-picker-search-icon" />
						<input
							ref={search}
							type="search"
							autoComplete="off"
							spellCheck={false}
							placeholder={translate(view.locale, "model.search")}
							aria-label={translate(view.locale, "model.search")}
							value={query}
							onChange={(event) => setQuery(event.currentTarget.value)}
						/>
					</label>
					{view.model.scopeNotice === undefined ? null : (
						<p className="model-picker-notice" aria-live="polite">
							{view.model.scopeNotice}
						</p>
					)}
					<div className="model-picker-list">
						{recentOptions.length === 0 ? null : (
							<>
								<p className="model-picker-heading">
									{translate(view.locale, "model.recent")}
								</p>
								{recentOptions.map((option) => (
									<button
										type="button"
										className="model-picker-option"
										aria-pressed={option.selected}
										title={`${option.provider}/${option.modelId}`}
										key={`recent:${optionKey(option)}`}
										onClick={() => choose(option)}
									>
										<span className="model-picker-option-label">
											{option.label}
										</span>
										<span className="model-picker-option-hint">
											{option.provider}
										</span>
										{option.selected ? (
											<Icon name="check" className="icon model-picker-check" />
										) : null}
									</button>
								))}
							</>
						)}
						{matchingGroups.map((group) => (
							<Fragment key={group.provider}>
								<p className="model-picker-heading">{group.provider}</p>
								{group.options.map((option) => (
									<button
										type="button"
										className="model-picker-option"
										aria-pressed={option.selected}
										data-active={firstMatch === option ? "true" : undefined}
										title={`${option.provider}/${option.modelId}`}
										key={optionKey(option)}
										onClick={() => choose(option)}
									>
										<span className="model-picker-option-label">
											{option.label}
										</span>
										{option.selected ? (
											<Icon name="check" className="icon model-picker-check" />
										) : null}
									</button>
								))}
							</Fragment>
						))}
						{matching.length === 0 ? (
							<p className="model-picker-empty">
								{query.trim().length === 0
									? (view.model.empty ?? translate(view.locale, "model.empty"))
									: translate(view.locale, "model.noMatch")}
							</p>
						) : null}
					</div>
					{view.model.levels.length < 2 ? null : (
						<div className="model-picker-reasoning">
							<span className="model-picker-section">
								{translate(view.locale, "model.effort")}
							</span>
							<div
								className="model-picker-levels"
								role="radiogroup"
								aria-label={translate(view.locale, "model.effort")}
							>
								{view.model.levels.map((level) => (
									// biome-ignore lint/a11y/useSemanticElements: The existing segmented-control CSS targets these buttons.
									<button
										type="button"
										className="model-picker-level"
										role="radio"
										aria-checked={level.selected}
										tabIndex={level.selected ? 0 : -1}
										key={level.level}
										onClick={() => actions.onSelectThinking(level.level)}
									>
										{level.label}
									</button>
								))}
							</div>
						</div>
					)}
					<button
						type="button"
						className="model-picker-manage"
						onClick={() => {
							setOpen(false);
							command(actions, MODEL_CONNECTIONS_ACTION);
						}}
					>
						<Icon name="sliders" className="icon model-picker-manage-icon" />
						<span>{translate(view.locale, "connections.manage")}</span>
					</button>
				</dialog>
			)}
		</>
	);
}

/** Ring and hover card for backend-reported context, tokens, cost, and compaction. */
export function ComposerStatusMeter({
	view,
	actions,
}: {
	readonly view: ComposerView;
	readonly actions: PageRenderer;
}) {
	const trigger = useRef<HTMLButtonElement>(null);
	const detail = useRef<HTMLDivElement>(null);
	const closeTimer = useRef<number | undefined>(undefined);
	const [open, setOpen] = useState(false);
	const hasContext = view.meter.context !== "?";
	const hasTokens = !view.meter.tokens.startsWith("? /");
	const hasCost = view.meter.cost !== "$0.000";
	const known = hasContext || hasTokens || hasCost;
	const [usedTokens = view.meter.tokens, totalTokens] =
		view.meter.tokens.split(" / ");
	const knownTotal = totalTokens !== undefined && totalTokens !== "?";
	const showTokens = hasTokens && (knownTotal || hasContext);
	const showCost = hasContext || hasTokens;
	const percent = Number.parseFloat(view.meter.context);
	const ratio =
		view.meter.context.endsWith("%") && Number.isFinite(percent)
			? Math.min(1, Math.max(0, percent / 100))
			: 0;
	const circumference = 2 * Math.PI * 6;
	const label = translate(view.locale, "header.meter", {
		context: view.meter.context,
		tokens: view.meter.tokens,
		cost: view.meter.cost,
	});

	const cancelClose = () => {
		if (closeTimer.current === undefined) return;
		window.clearTimeout(closeTimer.current);
		closeTimer.current = undefined;
	};
	const show = () => {
		cancelClose();
		setOpen(true);
	};
	const scheduleClose = () => {
		cancelClose();
		closeTimer.current = window.setTimeout(() => setOpen(false), 60);
	};

	useEffect(
		() => () => {
			if (closeTimer.current !== undefined)
				window.clearTimeout(closeTimer.current);
		},
		[],
	);
	useLayoutEffect(() => {
		if (!open) return;
		const anchor = trigger.current?.getBoundingClientRect();
		const card = detail.current;
		if (anchor === undefined || card === null) return;
		const left = Math.min(
			Math.max(8, anchor.left + anchor.width / 2 - card.offsetWidth / 2),
			window.innerWidth - card.offsetWidth - 8,
		);
		const above = anchor.top - card.offsetHeight - 8;
		card.style.left = `${Math.round(left)}px`;
		card.style.top = `${Math.round(above >= 8 ? above : anchor.bottom + 8)}px`;
	});

	if (view.attachedId === undefined || !known) return null;
	return (
		<div
			className="status-meter"
			data-tone={view.meter.tone}
			data-meter={ratio === 0 ? "empty" : undefined}
			onPointerEnter={show}
			onPointerLeave={scheduleClose}
		>
			<button
				ref={trigger}
				type="button"
				className="meter-trigger"
				title={label}
				aria-label={`${translate(view.locale, "header.meterToggle")}: ${label}`}
				onFocus={show}
				onBlur={(event) => {
					const next = event.relatedTarget;
					if (
						next instanceof Node &&
						(detail.current?.contains(next) === true ||
							event.currentTarget.contains(next))
					)
						return;
					setOpen(false);
				}}
				onClick={() => command(actions, USAGE_ACTION)}
			>
				<svg
					className="meter-ring"
					viewBox="0 0 16 16"
					aria-hidden="true"
					focusable="false"
				>
					<circle className="meter-ring-track" cx="8" cy="8" r="6" />
					<circle
						className="meter-ring-value"
						cx="8"
						cy="8"
						r="6"
						transform="rotate(-90 8 8)"
						strokeDasharray={circumference}
						strokeDashoffset={circumference * (1 - ratio)}
					/>
				</svg>
			</button>
			{createPortal(
				<div
					ref={detail}
					id="meter-detail"
					className="meter-detail"
					data-tone={view.meter.tone}
					data-open={open ? "true" : undefined}
					aria-hidden={!open}
					onPointerEnter={show}
					onPointerLeave={scheduleClose}
					onFocus={show}
					onBlur={(event) => {
						const next = event.relatedTarget;
						if (
							next instanceof Node &&
							(trigger.current?.contains(next) === true ||
								event.currentTarget.contains(next))
						)
							return;
						setOpen(false);
					}}
				>
					<div className="meter-detail-head">
						<p className="meter-detail-title">
							{translate(view.locale, "header.meterTitle")}
						</p>
						<p className="meter-detail-percent">
							<span>
								{hasContext
									? translate(view.locale, "header.meterContext")
									: hasTokens
										? translate(view.locale, "header.meterTokens")
										: translate(view.locale, "header.meterCost")}
							</span>
							<strong id="meter-context">
								{hasContext
									? view.meter.context
									: hasTokens
										? usedTokens
										: view.meter.cost}
							</strong>
						</p>
						<p className="meter-detail-line" hidden={!showTokens}>
							{knownTotal
								? translate(view.locale, "header.meterTokensOf", {
										used: usedTokens,
										total: totalTokens,
									})
								: translate(view.locale, "header.meterTokensUsed", {
										used: usedTokens,
									})}
						</p>
					</div>
					<div className="meter-detail-usage" hidden={!showCost}>
						<p className="meter-detail-line" id="meter-cost-line">
							<span>{translate(view.locale, "header.meterCost")}</span>
							<span>{view.meter.cost}</span>
						</p>
					</div>
					<button
						type="button"
						className="meter-compact"
						disabled={view.run.compact.disabled === true}
						title={translate(view.locale, "header.compactHint")}
						onClick={() =>
							command(actions, view.run.compact.id, view.run.compact.data)
						}
					>
						{view.run.compact.label}
					</button>
				</div>,
				document.body,
			)}
		</div>
	);
}
