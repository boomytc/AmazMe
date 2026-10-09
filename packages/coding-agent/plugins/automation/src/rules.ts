import { Temporal } from "@js-temporal/polyfill";
import type { ScheduleRule } from "@amazme/coding-agent/plugin";

export const MAX_SCHEDULE_TIME = Date.parse("9999-12-31T23:59:59.999Z");
export const MAX_TIMEOUT_SECONDS = 86_400;
export const MAX_GRACE_MINUTES = 10_080;
export const MINUTE = 60_000;

export function timestamp(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_SCHEDULE_TIME;
}

interface CronField {
	values: number[];
	star: boolean;
}
interface Cron {
	minutes: CronField;
	hours: CronField;
	days: CronField;
	months: CronField;
	weekdays: CronField;
}
const cache = new Map<string, Cron>();

function field(raw: string, min: number, max: number, sunday = false): CronField {
	const values = new Set<number>();
	for (const piece of raw.split(",")) {
		const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(piece);
		if (match === null) throw new Error(`Invalid cron field: ${raw}`);
		const step = match[2] === undefined ? 1 : Number(match[2]);
		const range = match[1]!;
		const [startText, endText] = range.split("-");
		const start = range === "*" ? min : Number(startText);
		const end = range === "*" || (match[2] !== undefined && endText === undefined) ? max : Number(endText ?? startText);
		if (!Number.isSafeInteger(step) || step < 1 || start < min || end > max || start > end)
			throw new Error(`Cron field must be within ${min}–${max}: ${raw}`);
		for (let value = start; value <= end; value += step) values.add(sunday && value === 7 ? 0 : value);
	}
	return { values: [...values].sort((a, b) => a - b), star: raw.startsWith("*") };
}

function cron(expression: string): Cron {
	const cached = cache.get(expression);
	if (cached !== undefined) return cached;
	const parts = expression.split(" ");
	if (parts.length !== 5) throw new Error("Cron needs five fields: minute hour day-of-month month day-of-week.");
	const result: Cron = {
		minutes: field(parts[0]!, 0, 59),
		hours: field(parts[1]!, 0, 23),
		days: field(parts[2]!, 1, 31),
		months: field(parts[3]!, 1, 12),
		weekdays: field(parts[4]!, 0, 7, true),
	};
	if (cache.size >= 128) cache.delete(cache.keys().next().value!);
	cache.set(expression, result);
	return result;
}

function zone(value: unknown): string {
	if (typeof value !== "string" || value.trim().length === 0 || /^[+-]/.test(value))
		throw new Error("Choose an IANA time zone.");
	try {
		return new Intl.DateTimeFormat("en", { timeZone: value.trim() }).resolvedOptions().timeZone;
	} catch {
		throw new Error(`Unknown time zone: ${value}`);
	}
}

/** Earlier overlap only; a skipped clock time never moves to a different local time. */
function localInstant(local: Temporal.PlainDateTime, timeZone: string): number | undefined {
	const zoned = local.toZonedDateTime(timeZone, { disambiguation: "earlier" });
	return zoned.toPlainDateTime().equals(local) ? zoned.epochMilliseconds : undefined;
}

export function normalizeRule(value: unknown): ScheduleRule {
	if (typeof value !== "object" || value === null || !("kind" in value)) throw new Error("Choose a schedule rule.");
	if (
		value.kind === "interval" &&
		"everyMinutes" in value &&
		typeof value.everyMinutes === "number" &&
		Number.isSafeInteger(value.everyMinutes) &&
		value.everyMinutes >= 1 &&
		value.everyMinutes * MINUTE <= MAX_SCHEDULE_TIME
	)
		return { kind: "interval", everyMinutes: value.everyMinutes };
	if ((value.kind === "once" || value.kind === "cron") && "timeZone" in value) {
		const timeZone = zone(value.timeZone);
		if (
			value.kind === "cron" &&
			"expression" in value &&
			typeof value.expression === "string" &&
			value.expression.length <= 256
		) {
			const expression = value.expression.trim().replace(/\s+/g, " ");
			cron(expression);
			return { kind: "cron", expression, timeZone };
		}
		if (
			value.kind === "once" &&
			"at" in value &&
			typeof value.at === "string" &&
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value.at)
		) {
			const local = Temporal.PlainDateTime.from(value.at, { overflow: "reject" });
			const instant = localInstant(local, timeZone);
			if (instant === undefined) throw new Error("That local time does not exist in the selected time zone.");
			if (!timestamp(instant)) throw new Error("Schedule time must be between 1970 and 9999.");
			return { kind: "once", at: local.toString(), timeZone };
		}
	}
	throw new Error(
		"Invalid schedule rule. Intervals use whole minutes; one-time rules need local ISO time and an IANA zone.",
	);
}

function dateMatches(date: Temporal.PlainDate, fields: Cron): boolean {
	const day = fields.days.values.includes(date.day);
	const weekday = fields.weekdays.values.includes(date.dayOfWeek % 7);
	return fields.days.star || fields.weekdays.star ? day && weekday : day || weekday;
}

/** Search calendar dates and selected times, skipping whole unselected months. */
function cronTarget(
	rule: Extract<ScheduleRule, { kind: "cron" }>,
	after: number,
	direction: 1 | -1,
	floor = 0,
): number | null {
	const fields = cron(rule.expression);
	const instant = Temporal.Instant.fromEpochMilliseconds(after);
	let date =
		direction === 1
			? instant.toZonedDateTimeISO(rule.timeZone).toPlainDate()
			: instant.toZonedDateTimeISO("UTC").toPlainDate().add({ days: 1 });
	const startYear = date.year;
	const lowerDate = Temporal.Instant.fromEpochMilliseconds(floor)
		.toZonedDateTimeISO(rule.timeZone)
		.toPlainDate()
		.subtract({ days: 1 });
	const hours = direction === 1 ? fields.hours.values : [...fields.hours.values].reverse();
	const minutes = direction === 1 ? fields.minutes.values : [...fields.minutes.values].reverse();
	while (date.year >= 1969 && date.year <= 9999 && Math.abs(date.year - startYear) <= 400) {
		if (direction === -1 && Temporal.PlainDate.compare(date, lowerDate) < 0) break;
		if (!fields.months.values.includes(date.month)) {
			date =
				direction === 1
					? date.with({ day: 1 }).add({ months: 1 })
					: date
							.with({ day: 1 })
							.subtract({ months: 1 })
							.with({ day: date.with({ day: 1 }).subtract({ months: 1 }).daysInMonth });
			continue;
		}
		if (dateMatches(date, fields)) {
			for (const hour of hours)
				for (const minute of minutes) {
					const candidate = localInstant(date.toPlainDateTime({ hour, minute }), rule.timeZone);
					if (
						candidate !== undefined &&
						timestamp(candidate) &&
						(direction === 1 ? candidate > after : candidate <= after && candidate >= floor)
					)
						return candidate;
				}
		}
		date = date.add({ days: direction });
	}
	return null;
}

export function firstTarget(rule: ScheduleRule, at: number): number | null {
	if (rule.kind === "once") return localInstant(Temporal.PlainDateTime.from(rule.at), rule.timeZone) ?? null;
	if (rule.kind === "cron") return cronTarget(rule, at, 1);
	const target = at + rule.everyMinutes * MINUTE;
	return timestamp(target) ? target : null;
}

/** Fixed-rate and calendar catch-up coalesce to one latest occurrence, never a replay burst. */
export function latestDue(rule: ScheduleRule, savedTarget: number, at: number): number {
	if (rule.kind === "once") return savedTarget;
	if (rule.kind === "cron") return Math.max(savedTarget, cronTarget(rule, at, -1, savedTarget) ?? savedTarget);
	const gap = rule.everyMinutes * MINUTE;
	return savedTarget + Math.floor(Math.max(0, at - savedTarget) / gap) * gap;
}

export function nextTarget(rule: ScheduleRule, occurrence: number, at: number): number | null {
	if (rule.kind === "once") return null;
	if (rule.kind === "cron") return cronTarget(rule, Math.max(occurrence, at), 1);
	const gap = rule.everyMinutes * MINUTE;
	const target = occurrence + (Math.floor(Math.max(0, at - occurrence) / gap) + 1) * gap;
	return timestamp(target) ? target : null;
}
