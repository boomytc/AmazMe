import type { ReactNode } from "react";
import { useMemo } from "react";
import { credentialRanges } from "../credentials.ts";
import type { Locale } from "../locale.ts";
import { translate } from "../strings.ts";
import { CredentialSecret } from "./credential-visibility.tsx";

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
	let from = 0;
	const content: ReactNode[] = [];
	for (const range of ranges) {
		if (range.start > from) content.push(text.slice(from, range.start));
		content.push(
			<CredentialSecret
				key={`credential:${range.start}`}
				text={text.slice(range.start, range.end)}
				masked={range.masked}
				locale={locale}
			/>,
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
