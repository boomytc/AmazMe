/** Shared graphical typography values. Stored by the Host and applied before the first page paint. */
export interface Typography {
	textFont: string;
	codeFont: string;
	terminalFont: string;
	textSize: number;
	codeSize: number;
	terminalSize: number;
}

export const DEFAULT_TYPOGRAPHY: Readonly<Typography> = Object.freeze({
	textFont: "", codeFont: "", terminalFont: "", textSize: 15, codeSize: 13, terminalSize: 12,
});
export const FONT_SIZE_LIMITS = {
	textSize: { min: 10, max: 22 }, codeSize: { min: 10, max: 16 }, terminalSize: { min: 10, max: 20 },
} as const;
export const FONT_SIZE_FIELDS = ["textSize", "codeSize", "terminalSize"] as const;
export const FONT_FAMILY_FIELDS = ["textFont", "codeFont", "terminalFont"] as const;
export type FontSizeAction = "increase" | "decrease" | "reset";

function fontSize(field: (typeof FONT_SIZE_FIELDS)[number], value: unknown): number {
	const { min, max } = FONT_SIZE_LIMITS[field];
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new Error(`${field} takes a whole number from ${min} to ${max}`);
	return value;
}

/** Accept a short list of font names, never CSS declarations or font downloads. */
export function normalizeFontFamily(value: string): string {
	if (value.length > 256) throw new Error("Font list must be at most 256 characters");
	if (value.trim() === "") return "";
	const names = value.split(",").map(part => {
		const name = part.trim().replace(/^(?:"([^"]*)"|'([^']*)')$/u, (_match, double: string | undefined, single: string | undefined) => double ?? single ?? "").trim();
		if (!/^[\p{L}\p{N} ._-]+$/u.test(name)) throw new Error("Use font names separated by commas");
		return name.replace(/ +/gu, " ");
	});
	if (names.length > 8) throw new Error("Use at most eight font names");
	return [...new Set(names)].join(", ");
}

export function validateTypography(patch: Partial<Typography>): Partial<Typography> {
	const result: Partial<Typography> = {};
	for (const field of FONT_FAMILY_FIELDS) {
		const value = patch[field];
		if (value !== undefined) {
			if (typeof value !== "string") throw new Error(`${field} takes a font list`);
			result[field] = normalizeFontFamily(value);
		}
	}
	for (const field of FONT_SIZE_FIELDS) {
		const value = patch[field];
		if (value === undefined) continue;
		result[field] = fontSize(field, value);
	}
	return result;
}

/** Hand-edited invalid fields fall back individually without discarding other valid preferences. */
export function resolveTypography(value: unknown): Typography {
	const result = { ...DEFAULT_TYPOGRAPHY };
	if (typeof value !== "object" || value === null || Array.isArray(value)) return result;
	const fields = value as Record<string, unknown>;
	for (const field of FONT_FAMILY_FIELDS) {
		const candidate = fields[field];
		try { if (typeof candidate === "string") result[field] = normalizeFontFamily(candidate); } catch { /* Keep this field's default. */ }
	}
	for (const field of FONT_SIZE_FIELDS) {
		try { result[field] = fontSize(field, fields[field]); } catch { /* Keep this field's default. */ }
	}
	return result;
}

/** All three relative adjustments are computed from the Host's latest values in its serialized settings write. */
export function adjustedFontSizes(current: Typography, action: FontSizeAction): Partial<Typography> {
	if (action !== "increase" && action !== "decrease" && action !== "reset") throw new Error("Unknown font size action");
	const result: Partial<Typography> = {};
	for (const field of FONT_SIZE_FIELDS) {
		const { min, max } = FONT_SIZE_LIMITS[field];
		result[field] = action === "reset" ? DEFAULT_TYPOGRAPHY[field] : Math.min(max, Math.max(min, current[field] + (action === "increase" ? 1 : -1)));
	}
	return result;
}

/** Values shared by the document's boot script and the running page; built-in fallback stacks remain available. */
export function typographyStyles(typography: Typography): Readonly<Record<string, string>> {
	const generics = new Set(["serif", "sans-serif", "monospace", "cursive", "fantasy", "system-ui", "ui-serif", "ui-sans-serif", "ui-monospace", "ui-rounded", "emoji", "math", "fangsong"]);
	const family = (value: string, fallback: string): string =>
		`${value === "" ? "" : `${value.split(", ").map(name => generics.has(name.toLowerCase()) ? name.toLowerCase() : JSON.stringify(name)).join(", ")}, `}var(${fallback})`;
	return {
		"--font-content": family(typography.textFont, "--font-sans"),
		"--font-code": family(typography.codeFont, "--font-mono"),
		"--font-terminal": family(typography.terminalFont, "--font-mono"),
		"--content-font-size": `${typography.textSize}px`,
		"--code-font-size": `${typography.codeSize}px`,
		"--terminal-font-size": `${typography.terminalSize}px`,
	};
}

export function applyTypography(style: { setProperty(name: string, value: string): void }, typography: Typography): void {
	for (const [name, value] of Object.entries(typographyStyles(typography))) style.setProperty(name, value);
}
