import {
	type ReactElement,
	useEffect,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";

/**
 * One path in the dock's file trail. The key is the path the host opens; the label is what the
 * reader sees, so two folders with the same name stay distinct.
 */
export interface BreadcrumbLevel {
	readonly key: string;
	readonly label: string;
}

interface BreadcrumbMetric {
	/** Natural width of the crumb: icon, padding and label. */
	readonly crumb: number;
	/** Natural width of the label alone. */
	readonly label: number;
}

type BreadcrumbSlot =
	| { readonly kind: "level"; readonly index: number }
	| { readonly kind: "gap"; readonly from: number; readonly to: number };

interface BreadcrumbPlan {
	/** Label width allowed for each level; 0 means the level folds to its icon. */
	readonly widths: readonly number[];
	/** Levels between `from` and `to` hide behind one ellipsis. `to` is exclusive. */
	readonly gap: { readonly from: number; readonly to: number } | null;
}

/** The fixed trail pieces, in CSS pixels. They match the rules in page.css. */
const SEPARATOR = 14;
const MIN_LABEL = 16;
const GAP_WIDTH = 22;
const SAFETY = 4;

/**
 * The dock's path trail. A long path folds in place instead of wrapping: everything fits, the whole
 * trail shows; the middle does not fit, the root and the last two folders keep their names; even
 * those do not fit, the middle folds behind one ellipsis and the remaining three keep names. Hovering
 * or focusing a level stretches its label to its natural width without moving the rest of the trail.
 */
export function Breadcrumbs({
	levels,
	label,
	disabled = false,
	onNavigate,
}: {
	readonly levels: readonly BreadcrumbLevel[];
	readonly label: string;
	readonly disabled?: boolean;
	readonly onNavigate: (key: string) => void;
}): ReactElement {
	const nav = useRef<HTMLElement>(null);
	const crumbRefs = useRef<Array<HTMLDivElement | null>>([]);
	const labelRefs = useRef<Array<HTMLSpanElement | null>>([]);
	const [metrics, setMetrics] = useState<readonly BreadcrumbMetric[]>([]);
	const [available, setAvailable] = useState(0);
	const [hovered, setHovered] = useState<string | null>(null);
	const [focused, setFocused] = useState<string | null>(null);

	const signature = levels.map((level) => `${level.key}\u0000${level.label}`).join("\u0001");
	const currentIndex = levels.length - 1;

	useEffect(() => {
		setHovered(null);
		setFocused(null);
	}, [signature]);

	useLayoutEffect(() => {
		const measure = (): void => {
			const next = levels.map((_, index) => ({
				crumb: crumbRefs.current[index]?.getBoundingClientRect().width ?? 0,
				label: labelRefs.current[index]?.getBoundingClientRect().width ?? 0,
			}));
			setMetrics((previous) =>
				sameMetrics(previous, next) ? previous : next,
			);
		};
		measure();
		let live = true;
		void document.fonts?.ready.then(() => {
			if (live) measure();
		});
		return () => {
			live = false;
		};
	}, [signature]);

	useLayoutEffect(() => {
		const element = nav.current;
		if (element === null) return;
		const update = (): void => {
			const next = element.clientWidth;
			setAvailable((previous) => (Math.abs(previous - next) < 0.5 ? previous : next));
		};
		update();
		const observer = new ResizeObserver(update);
		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	const plan = useMemo(() => planTrail(metrics, available), [metrics, available]);
	const slots = useMemo(
		() => buildSlots(levels.length, plan.gap),
		[levels.length, plan.gap],
	);
	const expanded = hovered ?? focused;

	function plannedWidth(slot: BreadcrumbSlot): number {
		if (slot.kind === "gap") return GAP_WIDTH;
		const metric = metrics[slot.index];
		if (metric === undefined) return 0;
		return (
			Math.max(0, metric.crumb - metric.label) +
			(plan.widths[slot.index] ?? metric.label)
		);
	}

	/** The hovered or focused level stretches into the room the plan left around it. */
	function labelWidth(index: number): number {
		const natural = metrics[index]?.label ?? 0;
		const planned = plan.widths[index] ?? natural;
		if (expanded !== levels[index]?.key) return planned;
		if (index !== currentIndex) return natural;
		// The current level has no following slot to borrow from, so it stops at the bar's edge.
		const slot = slots.findIndex(
			(item) => item.kind === "level" && item.index === index,
		);
		if (slot < 0) return natural;
		let used = 2;
		for (let before = 0; before < slot; before += 1) {
			const item = slots[before];
			if (item !== undefined) used += plannedWidth(item) + SEPARATOR;
		}
		const base = Math.max(0, (metrics[index]?.crumb ?? 0) - natural);
		return Math.min(natural, Math.max(0, available - used - base));
	}

	function hoverLevel(key: string, on: boolean): void {
		setHovered((current) => (on ? key : current === key ? null : current));
	}

	function focusLevel(key: string, on: boolean): void {
		setFocused((current) => (on ? key : current === key ? null : current));
	}

	return (
		<nav ref={nav} className="file-breadcrumbs" aria-label={label}>
			<div className="file-breadcrumbs-track">
				{slots.map((slot, position) => (
					<BreadcrumbSlotView
						key={
							slot.kind === "gap"
								? `gap:${slot.from}:${slot.to}`
								: levels[slot.index]?.key ?? ""
						}
						slot={slot}
						position={position}
						levels={levels}
						currentIndex={currentIndex}
						width={
							slot.kind === "level" ? Math.ceil(labelWidth(slot.index) + 0.5) : 0
						}
						disabled={disabled}
						onHover={hoverLevel}
						onFocus={focusLevel}
						onNavigate={onNavigate}
					/>
				))}
			</div>
			{/* Natural widths for every level, never painted: the plan is measured from these. */}
			<div aria-hidden="true" className="file-breadcrumbs-measure">
				{levels.map((level, index) => (
					<div
						key={level.key}
						ref={(node) => {
							crumbRefs.current[index] = node;
						}}
						className="file-crumb"
					>
						<FolderGlyph />
						<span
							ref={(node) => {
								labelRefs.current[index] = node;
							}}
							className="file-crumb-label"
						>
							{level.label}
						</span>
					</div>
				))}
			</div>
		</nav>
	);
}

function BreadcrumbSlotView({
	slot,
	position,
	levels,
	currentIndex,
	width,
	disabled,
	onHover,
	onFocus,
	onNavigate,
}: {
	readonly slot: BreadcrumbSlot;
	readonly position: number;
	readonly levels: readonly BreadcrumbLevel[];
	readonly currentIndex: number;
	readonly width: number;
	readonly disabled: boolean;
	readonly onHover: (key: string, on: boolean) => void;
	readonly onFocus: (key: string, on: boolean) => void;
	readonly onNavigate: (key: string) => void;
}): ReactElement {
	const separator =
		position === 0 ? null : (
			<span className="file-path-separator" aria-hidden="true">
				/
			</span>
		);
	if (slot.kind === "gap") {
		const hidden = levels.slice(slot.from, slot.to);
		return (
			<>
				{separator}
				<span
					className="file-path-gap"
					aria-hidden="true"
					title={hidden.map((level) => level.label).join(" / ")}
				>
					…
				</span>
			</>
		);
	}
	const level = levels[slot.index];
	if (level === undefined) return <>{separator}</>;
	const current = slot.index === currentIndex;
	const interactive = !current && !disabled;
	const enter = (): void => {
		onHover(level.key, true);
	};
	const leave = (): void => {
		onHover(level.key, false);
	};
	const focus = (): void => {
		onFocus(level.key, true);
	};
	const blur = (): void => {
		onFocus(level.key, false);
	};
	const label = (
		<>
			<FolderGlyph />
			<span className="file-crumb-label" style={{ maxWidth: `${width}px` }}>
				{level.label}
			</span>
		</>
	);
	return (
		<>
			{separator}
			{current ? (
				<span
					className="file-crumb current"
					title={level.key}
					aria-current="page"
					onMouseEnter={enter}
					onMouseLeave={leave}
				>
					{label}
				</span>
			) : (
				<button
					type="button"
					className="file-crumb"
					title={level.key}
					disabled={!interactive}
					onClick={() => {
						onNavigate(level.key);
					}}
					onMouseEnter={enter}
					onMouseLeave={leave}
					onFocus={focus}
					onBlur={blur}
				>
					{label}
				</button>
			)}
		</>
	);
}

function FolderGlyph(): ReactElement {
	return (
		<svg className="icon" viewBox="0 0 24 24" aria-hidden="true">
			<use href="#i-folder" />
		</svg>
	);
}

function buildSlots(
	count: number,
	gap: BreadcrumbPlan["gap"],
): readonly BreadcrumbSlot[] {
	if (gap === null)
		return Array.from({ length: count }, (_, index) => ({
			kind: "level",
			index,
		}));
	return [
		{ kind: "level", index: 0 },
		{ kind: "gap", from: gap.from, to: gap.to },
		...Array.from(
			{ length: Math.max(0, Math.min(2, count - 1)) },
			(_, offset): BreadcrumbSlot => ({ kind: "level", index: count - 2 + offset }),
		),
	];
}

function sameMetrics(
	left: readonly BreadcrumbMetric[],
	right: readonly BreadcrumbMetric[],
): boolean {
	if (left.length !== right.length) return false;
	return left.every((metric, index) => {
		const other = right[index];
		if (other === undefined) return false;
		return (
			Math.abs(metric.crumb - other.crumb) < 0.01 &&
			Math.abs(metric.label - other.label) < 0.01
		);
	});
}

function planTrail(
	metrics: readonly BreadcrumbMetric[],
	available: number,
): BreadcrumbPlan {
	const labels = metrics.map((metric) => metric.label);
	const count = metrics.length;
	if (count === 0) return { widths: [], gap: null };
	const usable = available - SAFETY;
	if (usable <= 0) return { widths: labels, gap: null };

	const bases = metrics.map((metric) => Math.max(0, metric.crumb - metric.label));
	const base =
		bases.reduce((sum, width) => sum + width, 0) +
		Math.max(0, count - 1) * SEPARATOR;
	const natural = labels.reduce((sum, width) => sum + width, 0);
	if (base + natural <= usable) return { widths: labels, gap: null };

	const fixed = [...new Set([0, count - 2, count - 1])].filter(
		(index) => index >= 0 && index < count,
	);
	const budget = usable - base;
	const fixedNatural = fixed.reduce((sum, index) => sum + (labels[index] ?? 0), 0);
	if (budget >= fixedNatural) {
		const widths = labels.map(() => 0);
		for (const index of fixed) widths[index] = labels[index] ?? 0;
		return { widths, gap: null };
	}
	if (count <= 3) return { widths: shareLabels(labels, fixed, budget), gap: null };

	const visible = buildSlots(count, { from: 1, to: count - 2 }).flatMap((slot) =>
		slot.kind === "level" ? [slot.index] : [],
	);
	const visibleBase = visible.reduce((sum, index) => sum + (bases[index] ?? 0), 0);
	const compactBudget =
		usable - visibleBase - visible.length * SEPARATOR - GAP_WIDTH;
	return {
		widths: shareLabels(labels, visible, compactBudget),
		gap: { from: 1, to: count - 2 },
	};
}

function shareLabels(
	labels: readonly number[],
	indices: readonly number[],
	budget: number,
): readonly number[] {
	const widths = labels.map(() => 0);
	const order = [...indices].sort((left, right) => right - left);
	let left = Math.max(0, budget);
	for (const index of order) {
		const width = Math.min(labels[index] ?? 0, MIN_LABEL);
		widths[index] = width;
		left -= width;
	}
	for (const index of order) {
		const extra = Math.min((labels[index] ?? 0) - (widths[index] ?? 0), left);
		widths[index] = (widths[index] ?? 0) + extra;
		left -= extra;
	}
	return widths;
}
