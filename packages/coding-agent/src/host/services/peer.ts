import { createHost, type Context } from "@amazme/chord";
import { openChannel, type ChannelInvoker } from "@amazme/protocol";
import { ServiceScope } from "@amazme/protocol/services";

export async function openServicePeer(invoke: ChannelInvoker, context: Context) {
	const connection = await openChannel(invoke, context);
	const host = createHost({ kind: "client" });
	const services = new ServiceScope(host, { at: connection.host });
	host.connect(connection.link);
	return {
		services,
		async close() {
			services.dispose();
			try {
				await host.close();
			} finally {
				await connection.close();
			}
		},
	};
}
