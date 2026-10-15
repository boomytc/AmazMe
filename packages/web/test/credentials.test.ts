import { expect, test } from "vitest";
import { credentialRanges } from "../src/credentials.ts";

const token = (prefix: string, length: number) => prefix + "a1B2c3D4".repeat(300).slice(0, length);
const values = (text: string) => credentialRanges(text).map(range => text.slice(range.start, range.end));

test.each([
	token("sk-", 32), token("sk-proj-", 48), token("AIza", 35), token("ghp_", 36),
	token("github_pat_", 82), token("glpat-", 20), token("npm_", 36), token("hf_", 30),
	"AKIAABCDEFGHIJ234567", "ASIAABCDEFGHIJ234567", token("LTAI", 20), token("AKID", 32),
	token("xoxb-", 24), token("sk_live_", 24), token("rk_test_", 24), token("whsec_", 32),
	`${token("eyJ", 17)}.${token("eyJ", 30)}.${token("", 43)}`,
])("recognizes a published credential format without changing surrounding prose: %s", sample => {
	const text = `之前 ${sample} 之后`;
	expect(values(text)).toEqual([sample]);
	expect(credentialRanges(text)[0]?.masked).toBe(sample.slice(0, 8) + "*".repeat(sample.length - 8));
});

test("does not guess prose, short keys, word suffixes or URL query data", () => {
	for (const text of ["password=hunter2", "sk-button-primary-large-rounded", "sk-12345", `task-${token("", 32)}`,
		"https://example.com:8443?email=alice@example.org", "git@github.com:o/r.git"])
		expect(values(text)).toEqual([]);
});

test("finds separate username keys and masks the complete URL password including a token", () => {
	const key = token("sk-", 32), password = token("ghp_", 36);
	const text = `https://${key}:${password}@example.org`;
	expect(values(text)).toEqual([key, password]);
	expect(credentialRanges(text).map(range => range.masked)).toEqual([key.slice(0, 8) + "*".repeat(key.length - 8), "*".repeat(password.length)]);
	expect(credentialRanges("redis://:p\u{1F600}\ud83dx@cache")[0]?.masked).toBe("****");
});

test("private key masks keep CRLF, headers and Unicode code point counts within their own block", () => {
	const header = "-----BEGIN OPENSSH PRIVATE KEY-----";
	const footer = "-----END OPENSSH PRIVATE KEY-----";
	const block = `${header}\r\na\u{1F600}c\r\n${footer}`;
	expect(credentialRanges(`before\n${block}\nafter`)[0]?.masked).toBe(`${header}\r\n***\r\n${footer}`);
	expect(credentialRanges(`${header}\nunfinished`)[0]?.masked).toBe(`${header}\n**********`);
	const oneLine = `${header}secret${footer}`;
	expect(credentialRanges(oneLine)[0]?.masked).toBe("*".repeat(oneLine.length));
});

test("merges overlapping formats and handles many prefixes and key blocks with forward scans", () => {
	const key = token("sk-", 32);
	const block = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
	expect(values(key + block)).toEqual([key + block]);
	const text = `${"sk-no-digit ".repeat(20_000)}${`${block}\n`.repeat(500)}${key}`;
	const ranges = credentialRanges(text);
	expect(ranges).toHaveLength(501);
	expect(text.slice(ranges.at(-1)!.start)).toBe(key);
});
