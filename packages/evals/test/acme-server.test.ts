import { expect, test } from "vitest";
import { createAcmeServer } from "../evals/acme-server.ts";
test("the fixture rejects a wrong key without recording a valid probe", async () => {
	const server = createAcmeServer("openai");
	await server.start();
	try {
		const response = await fetch(`${server.baseUrl()}/chat/completions`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer wrong" },
			body: JSON.stringify({ messages: [] }),
		});
		expect(response.status).toBe(401);
		expect(server.validRequestReceived()).toBe(false);
	} finally {
		await server.stop();
	}
});
