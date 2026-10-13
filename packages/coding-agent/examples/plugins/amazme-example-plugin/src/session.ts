import { serviceFacet, type ServiceValue } from "@amazme/protocol/services";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { ExampleFacetService } from "./contract.ts";

export default serviceFacet("@amazme/example-plugin/session", ExampleFacetService, [], async (services) => {
	const workerActivations = replicatedState({ count: 0 });
	const implementation: ServiceValue<typeof ExampleFacetService> = {
		workerActivations,
		async greet({ name }) {
			return {
				message: `Hello ${name} from the bundled Session worker facet!!!`,
				workerActivations: workerActivations.value.count,
			};
		},
	};
	await (() => {
		workerActivations.change(BACKGROUND_CONTEXT, (draft) => {
			draft.count += 1;
		});
	})();

	return { value: implementation };
});
