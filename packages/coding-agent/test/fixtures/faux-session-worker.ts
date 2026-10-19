import type { Facet } from "@amazme/chord";
import { Type } from "typebox";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { createModels, fauxAssistantMessage, fauxProvider } from "@amazme/ai";
import { createRegistry, Harness } from "@amazme/durable";
import { openSessionStorage } from "../../src/durable/session-database.ts";
import { consumeInternalProcessRole } from "../../src/host/process.ts";
import { runSessionWorkerWithHarness } from "../../src/host/session-worker.ts";
import { KeyedProbe } from "./keyed-service.ts";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Faux Session worker requires a session-worker invocation");
	void runSessionWorkerWithHarness(process.argv.slice(2), async (lease, options) => {
		if (options.provider !== "anthropic" || options.model !== "claude-sonnet-4-5") {
			throw new Error(`Unexpected faux worker model: ${options.provider}/${options.model}`);
		}
		const faux = fauxProvider();
		const answer = fauxAssistantMessage("deterministic remote answer", { timestamp: 20 });
		faux.setResponses([answer, answer]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = await Harness.open(
			await openSessionStorage(lease),
			{ models, registry: createRegistry() },
			BACKGROUND_CONTEXT,
		);
		const model = faux.getModel();
		const conversation = await harness.root(BACKGROUND_CONTEXT, {
			agent: { cwd: options.metadata.cwd, model: { provider: model.provider, modelId: model.id } } });
		const keyedProbeFacet: Facet = { name: "keyed-probe", setup(api) {
   api.serve(KeyedProbe, (_input, _principal, self) => {
    const state = self.state("state", Type.Object({ value: Type.String() }), { value: "first" });
    return { variant: "default", state,
     replace(value, context) { state.change(context, draft => { draft.value = value; }); return null; },
     wait(_input, context) { return new Promise<null>((_resolve, reject) => {
      if (context.signal.aborted) reject(abortError(context.signal));
      else context.signal.addEventListener("abort", () => reject(abortError(context.signal)), { once: true });
     }); },
    };
   });
  } };
		return { cwd: options.metadata.cwd, harness, conversation, facetLoader: async () => [keyedProbeFacet] };
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
