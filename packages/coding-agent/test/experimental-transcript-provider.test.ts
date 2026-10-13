import { openTestHost } from "./native-host-support.ts";
import { activationFacet, disposeResources } from "@amazme/protocol/services";
import { } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { fauxAssistantMessage } from "@amazme/ai";
import type { ConversationView } from "@amazme/durable";
import { describe, expect, test } from "vitest";
import { Transcript } from "../src/host/services/transcript.ts";
import { createTranscriptServiceFacet } from "../src/host/services/transcript-provider.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

describe("Transcript service", () => {
	test("replicates the conversation view as it changes", async () => {
		const { conversation, close } = await openFauxConversation([fauxAssistantMessage("answer")]);
		const views: ConversationView[] = [];
		const consumer = activationFacet("test-transcript-consumer", [Transcript], async (services) => {
			const disposers: Array<() => void | Promise<void>> = [];
			try {
				const transcript = services.get(Transcript);
				await (() => disposers.push(transcript.state.subscribe((value) => void views.push(value))))();

				return () => disposeResources(disposers);
			} catch (error) {
				await disposeResources(disposers);
				throw error;
			}
		});
		const host = await openTestHost({
			facets: [await createTranscriptServiceFacet(conversation, BACKGROUND_CONTEXT), consumer] });
		try {
			expect(views[0]?.entries).toEqual([]);
			const submission = await conversation.submit({ type: "input", content: "question" }, BACKGROUND_CONTEXT);
			await submission.wait(BACKGROUND_CONTEXT);
			await expect.poll(() => views.at(-1)?.entries.map((entry) => entry.kind)).toEqual(["amazme.user", "amazme.assistant"]);
		} finally {
			await host.dispose();
			await close();
		}
	});
});
