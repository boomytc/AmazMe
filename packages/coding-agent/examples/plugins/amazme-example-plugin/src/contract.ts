import { remoteService } from "@amazme/protocol/services";
import { type Context, type ReplicatedState } from "@amazme/chord";

export interface ExampleFacetReply {
	readonly message: string;
	readonly workerActivations: number;
}

export interface ExampleFacetService {
	readonly workerActivations: ReplicatedState<{ count: number }>;
	greet(input: { readonly name: string }, context: Context): Promise<ExampleFacetReply>;
}

export const ExampleFacetService = remoteService<ExampleFacetService>("amazme.example-plugin.greeting", { greet: 1 }, ["workerActivations"]);
