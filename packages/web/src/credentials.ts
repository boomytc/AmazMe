import { CredentialScanner } from "./credentials/credential-scanner.ts";
import type { CredentialRange } from "./credentials/credential-scanner.ts";
import { formatTables } from "./credentials/format-tables.ts";

/** Display ranges only. The caller retains the original message for copying and submission. */
export function credentialRanges(text: string): CredentialRange[] {
	const scanner = new CredentialScanner(formatTables());
	const ranges: CredentialRange[] = [];
	let from = 0;
	while (from < text.length) {
		const range = scanner.match(text, from);
		if (range === undefined) break;
		ranges.push(range);
		from = range.end;
	}
	return ranges;
}
