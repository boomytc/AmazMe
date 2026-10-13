import { activationFacet } from "@amazme/protocol/services";
import { type FacetLoader } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { describe, expect, test, vi } from "vitest";
import { SessionPlugins } from "../src/host/services/plugins.ts";
import { openWorkerTestServices } from "./native-host-support.ts";
import { openFauxConversation } from "./experimental-durable-support.ts";

describe("experimental plugin reload", () => {
	test("loads and cuts over a fresh Session facet generation", async () => {
		const activations: number[] = [];
		const disposals: number[] = [];
		let generation = 0;
		const facetLoader: FacetLoader = async () => {
			const current = ++generation;
			return [
				activationFacet("reloadable-session-plugin", [], () => {
					activations.push(current);
					return () => {
						disposals.push(current);
					};
				}),
			];
		};
		const { harness, conversation, close } = await openFauxConversation();
		const services = await openWorkerTestServices({
			cwd: process.cwd(),
			harness,
			conversation,
			modelRuntime: undefined,
			facetLoader,
		});
		try {
			expect(activations).toEqual([1]);
			const plugins = services.services.get(SessionPlugins);
			await services.services.ready();
			await plugins.reload(BACKGROUND_CONTEXT);
			expect(activations).toEqual([1, 2]);
			expect(disposals).toEqual([1]);
		} finally {
			await services.close();
			await close();
		}
		expect(disposals).toEqual([1, 2]);
	});
});
