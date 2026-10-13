import { activationFacet, disposeResources } from "@amazme/protocol/services";
import { AgentController, PresentationUI, SlashCommands } from "@amazme/coding-agent/host/plugin";
import { ExampleFacetService } from "./contract.ts";

export default activationFacet(
	"@amazme/example-plugin/tui",
	[ExampleFacetService, SlashCommands, AgentController, PresentationUI],
	async (services) => {
		const disposers: Array<() => void | Promise<void>> = [];
		try {
			const example = services.get(ExampleFacetService);
			const commands = services.get(SlashCommands);
			const controller = services.get(AgentController);
			const ui = services.get(PresentationUI);
			await (() => {
				disposers.push(
					commands.replace({
						name: "hello",
						description: "Call the bundled Session worker facet",
						argumentHint: "<name>",
						async run(args, context) {
							const message = args.length === 0 ? "from the TUI" : args;
							const reply = await example.greet({ name: message }, context);
							ui.showStatus(`We got this: ${reply.message} Worker activations: ${reply.workerActivations}.`, context);
							return controller.prompt({ message: `pong: ${message}`, images: null }, context);
						},
					}),
				);
			})();

			return () => disposeResources(disposers);
		} catch (error) {
			await disposeResources(disposers);
			throw error;
		}
	},
);
