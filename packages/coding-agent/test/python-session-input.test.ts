import { afterEach, expect, test, vi } from "vitest";
import { HostClient } from "../src/python-headless.ts";
import { handleLine, PendingPrompts, type ScreenState } from "../src/python-session-tui.ts";

afterEach(() => vi.unstubAllGlobals());

const sessions = [
	{
		session_id: "a".repeat(32),
		workspace: "primary",
		title: "one",
		archived: false,
	},
	{
		session_id: "b".repeat(32),
		workspace: "docs",
		title: "other",
		archived: false,
	},
	{
		session_id: "c".repeat(32),
		workspace: "primary",
		title: "recent",
		archived: false,
	},
	{
		session_id: "d".repeat(32),
		workspace: "primary",
		title: "archived",
		archived: true,
	},
];
const reply = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status });

function mockHost(
	submission: () => Response | Promise<Response>,
	poll = () =>
		reply({ request_id: "original", status: "succeeded", answer: "done" }),
) {
	const fetchMock = vi.fn(
		async (input: string | URL | Request, init?: RequestInit) => {
			const path = String(input);
			if (path.endsWith("/bootstrap"))
				return reply({ build_id: "build", host_epoch: 7 });
			if (path.endsWith("/sessions")) return reply({ sessions });
			if (path.endsWith("/submissions")) return submission();
			if (path.endsWith("/requests/original")) return poll();
			throw new Error(`Unexpected ${init?.method} ${path}`);
		},
	);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

test("local TUI queue keeps Unicode and order, rejects overflow without consuming it, and recovers capacity", () => {
	const queue = new PendingPrompts();
	const input = Array.from({ length: 32 }, (_, i) => `中文🙂 ${i}`);
	for (const item of input) expect(queue.push(item)).toBe(true);
	expect(queue.push("overflow")).toBe(false);
	for (const item of input) expect(queue.shift()).toBe(item);
	expect(queue.shift()).toBeUndefined();
	expect(queue.push("🙂".repeat(16384))).toBe(true);
	expect(queue.push("x")).toBe(false);
	expect(queue.shift()).toBe("🙂".repeat(16384));
	expect(queue.push("next")).toBe(true);
});

test("continue selects recent active session within the captured workspace", async () => {
	mockHost(() => reply({}));
	const client = new HostClient("http://127.0.0.1:1000", "token");
	await client.bootstrap();
	expect(await client.recent("primary")).toBe("c".repeat(32));
	expect(await client.recent("docs")).toBe("b".repeat(32));
	expect(await client.recent("absent")).toBeUndefined();
});

test.each(["lost_post", "lost_poll"])(
	"%s keeps the original request ID without a second submission",
	async (failure) => {
		const fetchMock = mockHost(
			() => {
				if (failure === "lost_post") throw new TypeError("connection lost");
				return reply({});
			},
			() => {
				throw new TypeError("poll lost");
			},
		);
		const client = new HostClient("http://127.0.0.1:1000", "token");
		await client.bootstrap();
		const result = await client.submit(
			"a".repeat(32),
			"primary",
			"attachment",
			"hello",
			[],
			"original",
		);
		expect(result.receipt).toMatchObject({
			status: "unknown",
			request_id: "original",
		});
		const calls = fetchMock.mock.calls.filter(([url]) =>
			String(url).endsWith("/submissions"),
		);
		expect(calls).toHaveLength(1);
		expect(JSON.parse(String(calls[0]?.[1]?.body))).toMatchObject({
			request_id: "original",
			text: "hello",
		});
	},
);

test("a known rejection stays a rejection instead of an unknown accepted operation", async () => {
	mockHost(() => reply({ code: "request_conflict" }, 409));
	const client = new HostClient("http://127.0.0.1:1000", "token");
	await client.bootstrap();
	await expect(
		client.submit(
			"a".repeat(32),
			"primary",
			"attachment",
			"hello",
			[],
			"original",
		),
	).rejects.toMatchObject({ status: 409, message: "request_conflict" });
});


test("local launch directory selection goes through Python with the explicit workspace unchanged", async () => {
    const calls: unknown[] = [];
    vi.stubGlobal("fetch", async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body)));
        return reply({name:"cwd-owned",host_path:"/projects/current"});
    });
    const client = new HostClient("http://127.0.0.1:1000", "token");
    expect(await client.selectWorkspace("/projects/current")).toBe("cwd-owned");
    expect(await client.selectWorkspace("/projects/other", "selected")).toBe("cwd-owned");
    expect(calls).toEqual([{host_path:"/projects/current",name:""},{host_path:"/projects/other",name:"selected"}]);
});


test("retrying an unconfirmed approval keeps its original proposal and decision ID", async () => {
    let requestId = "", latest = "old";
    const decisions: Array<Record<string, unknown>> = [];
    const approval = () => ({request_id:requestId, approval_id:latest, revision:latest,
        proposal_digest:`digest-${latest}`, state:"pending", call:{name:"shell",arguments:JSON.stringify({command:latest})}});
    vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
        if (url.endsWith("/bootstrap")) return reply({build_id:"build",host_epoch:7});
        if (url.endsWith("/sessions")) return reply({sessions});
        if (url.endsWith("/submissions")) {
            const body: Record<string, unknown> = JSON.parse(String(init?.body));
            requestId = String(body.request_id);
            return reply({});
        }
        if (url.includes("/requests/")) return reply({request_id:requestId,status:"waiting_approval"});
        if (url.endsWith("/snapshot")) return reply({approvals:[approval()]});
        if (url.endsWith("/approvals")) {
            decisions.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
            latest = "new";
            if (decisions.length === 1) throw new TypeError("lost receipt");
            return reply({});
        }
        throw new Error(`Unexpected ${url}`);
    });
    const client = new HostClient("http://127.0.0.1:1000", "token");
    await client.bootstrap();
    const state: ScreenState = {terminalId:"",serverId:"",held:null,pendingInput:null};
    await handleLine(client, "a".repeat(32), "attachment", "primary", state, "do work");
    await expect(handleLine(client, "a".repeat(32), "attachment", "primary", state, "批准")).rejects.toThrow("lost receipt");
    await handleLine(client, "a".repeat(32), "attachment", "primary", state, "批准");
    expect(decisions).toHaveLength(2);
    expect(decisions[0]).toEqual(decisions[1]);
    expect(decisions[1]).toMatchObject({approval_id:"old",proposal_digest:"digest-old",approve:true});
    expect(state.held?.summary).toContain("new");
    expect(state.held?.decision).toBeUndefined();
});
