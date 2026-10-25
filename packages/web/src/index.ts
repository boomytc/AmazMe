/** Client presentation components; the Python backend owns business state and execution. */
export { collectPageElements, createRenderer, type PageElements, type PageRenderer } from "./render.ts";
export type { WebView, TranscriptBlock } from "./view.ts";
export { errorCodeCopy, errorMessageCopy, toolDiagnosticCopy } from "./errors.ts";
export {
	documentLanguage,
	FALLBACK_LOCALE,
	isLocale,
	LOCALES,
	matchLocale,
	resolveLocale,
	type Locale,
	type LocalePreference,
} from "./locale.ts";
export { translate, type MessageKey } from "./strings.ts";
export { DEFAULT_TYPOGRAPHY, resolveTypography, typographyStyles, type Typography } from "./typography.ts";
