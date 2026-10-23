import { existsSync, writeFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import type { Conversation } from "@amazme/durable";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { createShareCommand, type ShareCommandOptions } from "../src/host/services/share-command.ts";
import type { ShareOutcome } from "../src/core/session-share.ts";

function conversation(): Conversation {
	return {
		id: 7,
		viewState: async () => ({
			value: { entries: [{ id: 1, kind: "user" }] },
			dispose: () => {},
		}),
	} as unknown as Conversation;
}

function options(share: ShareCommandOptions["share"], destination: () => "auto" | "radius" | "gist" = () => "gist") {
	return {
		conversation: conversation(),
		cwd: "/project",
		destination,
		exportEntries: async ({ jsonlFile, htmlFile }: { jsonlFile: string; htmlFile: string }) => {
			writeFileSync(jsonlFile, "{}\n");
			writeFileSync(htmlFile, "<html></html>");
		},
		share,
	} satisfies ShareCommandOptions;
}

describe("share command", () => {
	test("exports both formats and returns the viewer URL", async () => {
		let seen: { jsonlFile: string; htmlFile: string; destination: string } | undefined;
		const command = createShareCommand(
			options(async (files) => {
				seen = files;
				expect(existsSync(files.jsonlFile)).toBe(true);
				expect(existsSync(files.htmlFile)).toBe(true);
				return { ok: true, url: "https://pi.dev/session/#abc", gistUrl: "https://gist.github.com/u/abc" };
			}),
		);

		await expect(command.run("", BACKGROUND_CONTEXT)).resolves.toEqual({
			note: "Share URL: https://pi.dev/session/#abc · Gist: https://gist.github.com/u/abc",
		});
		expect(seen?.destination).toBe("gist");
	});

	test("reads the destination for each run", async () => {
		let destination: "auto" | "radius" | "gist" = "gist";
		const seen: string[] = [];
		const command = createShareCommand(
			options(async (files) => {
				seen.push(files.destination);
				return { ok: true, url: "https://pi.dev/session/#1" };
			}, () => destination),
		);

		await command.run("", BACKGROUND_CONTEXT);
		destination = "radius";
		await command.run("", BACKGROUND_CONTEXT);
		expect(seen).toEqual(["gist", "radius"]);
	});

	test("refuses the old durable export when no replacement writer is supplied", async () => {
		const command = createShareCommand({
			conversation: conversation(),
			cwd: "/project",
			destination: () => "gist",
		});
		await expect(command.run("", BACKGROUND_CONTEXT)).rejects.toThrow("old_session_migration_removed");
	});

	test("throws the uploader's reason so the command runner can show it", async () => {
		const command = createShareCommand(
			options(async (): Promise<ShareOutcome> => ({
				ok: false,
				problem: "Radius authentication is not configured. Run '/login radius' first.",
			})),
		);

		await expect(command.run("", BACKGROUND_CONTEXT)).rejects.toThrow(
			"Radius authentication is not configured. Run '/login radius' first.",
		);
	});
});
