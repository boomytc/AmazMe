import { createHost, memoryLinkPair, type Facet } from "@amazme/chord";
import { ServiceHost, ServiceScope } from "@amazme/protocol/services";
import { sourceFacets } from "../src/host/services/connection.ts";

export async function openTestHost(options: {
	facets: readonly Facet[];
	serviceSources?: Parameters<typeof sourceFacets>[1];
}) {
	const host = createHost({ name: "test-host" });
	const services = new ServiceHost(host.name, host);
	try {
		await host.load([...(await sourceFacets(options.facets, options.serviceSources ?? [])), ...options.facets]);
	} catch (error) {
		await host.close();
		throw error;
	}
	return { host, services, reload: host.reload.bind(host), dispose: () => services.dispose() };
}
export function connectTestHost(host: ReturnType<typeof createHost>) {
	const client = createHost({ kind: "client" });
	const [left, right] = memoryLinkPair();
	host.accept(left, { principal: "test-client" });
	client.connect(right);
	const scope = new ServiceScope(client, { at: host.name });
	return {
		scope,
		async close() {
			scope.dispose();
			await client.close();
		},
	};
}

import type { Frame } from "@amazme/chord";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { createSessionWorkerServices } from "../src/host/services/worker.ts";
import { openServicePeer } from "../src/host/services/peer.ts";
export async function openWorkerTestServices(
	options: Omit<Parameters<typeof createSessionWorkerServices>[0], "publish">,
) {
	const listeners = new Map<
		string,
		(channel: string, frame: Frame | undefined, context: typeof BACKGROUND_CONTEXT) => void | Promise<void>
	>();
	const scope = { serverConnectionId: "test-server", attachmentId: "test-attachment" };
	const worker = await createSessionWorkerServices({
		...options,
		publish: async (_scope, channel, frame) => {
			await listeners.get(channel)?.(channel, frame, BACKGROUND_CONTEXT);
		},
	});
	const peer = await openServicePeer(async (call, publish, context) => {
		if (call.kind === "open") listeners.set(call.channel, publish);
		const result = await worker.invoke(call, scope, context);
		if (call.kind === "close") listeners.delete(call.channel);
		return result;
	}, BACKGROUND_CONTEXT);
	return {
		...peer,
		worker,
		async close() {
			try {
				await peer.close();
			} finally {
				await worker.dispose();
			}
		},
	};
}
