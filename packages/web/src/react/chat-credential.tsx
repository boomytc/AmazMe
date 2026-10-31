import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { credentialRanges } from "../credentials.ts";
import type { Locale } from "../locale.ts";
import { translate } from "../strings.ts";

interface CredentialTextProps {
	readonly text: string;
	readonly className: string;
	readonly locale: Locale;
	readonly textKey?: string;
}

/** Text with each detected credential masked until the reader explicitly reveals it. */
export function CredentialText({
	text,
	className,
	locale,
	textKey,
}: CredentialTextProps) {
	const ranges = useMemo(() => credentialRanges(text), [text]);
	const [revealed, setRevealed] = useState<ReadonlySet<number>>(
		() => new Set(),
	);
	let from = 0;
	const content: ReactNode[] = [];
	for (const range of ranges) {
		if (range.start > from) content.push(text.slice(from, range.start));
		const shown = revealed.has(range.start);
		content.push(
			<span className="credential-secret" key={`credential:${range.start}`}>
				<span className="credential-value">
					{shown ? text.slice(range.start, range.end) : range.masked}
				</span>
				<button
					type="button"
					className="credential-toggle"
					aria-pressed={shown}
					aria-label={translate(
						locale,
						shown ? "secret.hideAria" : "secret.showAria",
					)}
					onClick={() =>
						setRevealed((current) => {
							const next = new Set(current);
							if (next.has(range.start)) next.delete(range.start);
							else next.add(range.start);
							return next;
						})
					}
				>
					{translate(locale, shown ? "secret.hide" : "secret.show")}
				</button>
			</span>,
		);
		from = range.end;
	}
	if (from < text.length) content.push(text.slice(from));
	return (
		<span
			className={className}
			data-text-key={textKey}
			title={
				ranges.length === 0 ? undefined : translate(locale, "copy.sensitive")
			}
		>
			{content}
		</span>
	);
}
