import { describe, expect, it } from "vitest";
import { encodeFrameObject, memoryLinkPair, webSocketLink } from "../src/index.ts";
import type { Frame, WebSocketLike } from "../src/index.ts";

describe("packed object transports", () => {
	it("closes malformed object envelopes without an unhandled delivery rejection", async () => {
		const [sender, receiver] = memoryLinkPair();
		const reason = new Promise<string>(resolve => receiver.onClose(resolve));
		sender.send({ t: "result", id: 1, z: ["invalid", ""] } as unknown as Frame);
		expect(await reason).toBe("protocol error");
		expect(receiver.closed).toBe(true);
		sender.close();
	});

	it.each([false, true])("honors WebSocket packed policy for text envelopes (acceptPacked: %s)", async acceptPacked => {
		let receive: (event: { data: unknown }) => void = () => {};
		const socket: WebSocketLike = {
			readyState: 1,
			send() {}, close() {},
			addEventListener(type, listener) {
				if (type === "message") receive = listener;
			},
		};
		const link = webSocketLink(socket, { acceptPacked });
		const frames: Frame[] = [];
		link.receive(frame => frames.push(frame));
		const frame: Frame = { t: "result", id: 1, value: "large".repeat(20_000) };
		receive({ data: JSON.stringify(encodeFrameObject(frame)) });
		expect(frames).toHaveLength(acceptPacked ? 1 : 0);
		expect(link.closed).toBe(!acceptPacked);
		link.close();
	});
});
