#!/usr/bin/env node
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const image = readFileSync(join(root, "capture.png"));
const mode = readFileSync(join(root, "mode.txt"), "utf8");
const log = (event) =>
	appendFileSync(join(root, "events.jsonl"), `${JSON.stringify(event)}\n`);
log({
	event: "started",
	pid: process.pid,
	argv: process.argv.slice(2),
	secretsPresent: Boolean(
		process.env.TYPESAFE_API_KEY || process.env.OPENAI_API_KEY,
	),
	telemetry: process.env.CUA_DRIVER_RS_TELEMETRY_ENABLED,
});
const schema = (fields) => ({
	type: "object",
	properties: Object.fromEntries(
		["session", ...fields].map((field) => [field, {}]),
	),
	additionalProperties: false,
});
const definitions = {
	list_apps: [],
	list_windows: ["pid"],
	check_permissions: [],
	end_session: [],
	get_window_state: [
		"pid",
		"window_id",
		"include_accessibility_tree",
		"include_screenshot",
		"tree_format",
		"max_elements",
		"max_image_dimension",
	],
	get_desktop_state: ["max_image_dimension"],
	click: [
		"target",
		"delivery_mode",
		"x",
		"y",
		"capture_id",
		"element_token",
		"count",
		"button",
	],
	set_value: ["pid", "window_id", "element_token", "value"],
	type_text: ["target", "element_token", "text", "delivery_mode"],
	press_key: ["target", "key", "delivery_mode"],
	hotkey: ["target", "keys", "delivery_mode"],
	scroll: [
		"target",
		"element_token",
		"x",
		"y",
		"direction",
		"amount",
		"delivery_mode",
	],
	drag: ["target", "from_x", "from_y", "to_x", "to_y", "delivery_mode"],
};
// The pinned 0.34.1 runtime always returns both tree forms and has no tree_format argument.
if (mode === "pinned")
	definitions.get_window_state = definitions.get_window_state.filter(
		(field) => field !== "tree_format",
	);
let observation = 0;
const tools = Object.entries(definitions).map(([name, fields]) => ({
	name,
	inputSchema: schema(fields),
}));
const send = (id, result) =>
	process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
const envelope = (data, picture = false) => ({
	content: [
		{ type: "text", text: JSON.stringify(data) },
		...(picture
			? [
					{
						type: "image",
						data: image.toString("base64"),
						mimeType: "image/png",
					},
				]
			: []),
	],
	structuredContent: data,
});
createInterface({ input: process.stdin }).on("line", async (line) => {
	const request = JSON.parse(line);
	if (request.id === undefined) return;
	if (request.method === "initialize")
		return send(request.id, {
			protocolVersion: request.params.protocolVersion,
			capabilities: { tools: {} },
			serverInfo: { name: "fixture-cua", version: "0.34.1" },
		});
	if (request.method === "tools/list") return send(request.id, { tools });
	if (request.method !== "tools/call") return send(request.id, {});
	const { name, arguments: args } = request.params;
	log({ event: "call", name, args });
	if (
		Object.keys(args).some(
			(field) => field !== "session" && !definitions[name]?.includes(field),
		)
	)
		return send(request.id, {
			isError: true,
			content: [{ type: "text", text: "Unexpected driver field" }],
		});
	if (["get_window_state", "get_desktop_state"].includes(name)) {
		observation++;
		if (mode === "verify-refuse" && observation > 1)
			return send(request.id, {
				isError: true,
				...envelope({ error: "verification_capture_unavailable" }),
			});
		const snapshot = `s${observation}`;
		const data = {
			...(name === "get_window_state"
				? {
						pid: args.pid,
						window_id: args.window_id,
						snapshot_id: snapshot,
						window_bounds: {
							x: 100,
							y: 200,
							width: image.readUInt32BE(16) / 2,
							height: image.readUInt32BE(20) / 2,
						},
					}
				: {}),
			capture_id: `capture-${observation}`,
			screenshot_width: image.readUInt32BE(16),
			screenshot_height: image.readUInt32BE(20),
			tree_markdown: `Counter ${observation > 1 ? "1" : "0"}`,
			degraded_reason: mode === "noax" ? "ax_tree_empty" : undefined,
			elements:
				mode === "noax"
					? []
					: [
							{
								role: "AXWindow",
								element_index: 0,
								label: "Fixture",
								element_token: `${snapshot}:0`,
							},
							...["Increment", "Delete", "Send", "Title"].map(
								(label, index) => ({
									role: label === "Title" ? "AXTextField" : "AXButton",
									label,
									element_index: index + 1,
									parent_index: 0,
									element_token: `${snapshot}:${index + 1}`,
									enabled: true,
									frame: { x: 110, y: 210, w: 100, h: 30 },
								}),
							),
						],
		};
		if (mode === "mismatch") data.pid = -1;
		return send(request.id, envelope(data, true));
	}
	if (name === "check_permissions")
		return send(
			request.id,
			envelope({ accessibility: true, screen_recording: true }),
		);
	if (name === "list_apps" || name === "list_windows")
		return send(request.id, envelope({ items: [] }));
	if (name === "click" && mode === "refuse")
		return send(request.id, {
			isError: true,
			...envelope({ error: "background_unavailable" }),
		});
	if (mode === "slow" && name === "click")
		await new Promise((resolve) => setTimeout(resolve, 2000));
	return send(request.id, envelope({ success: true }));
});
process.stdin.on("end", () => {
	log({ event: "exited" });
	process.exit(0);
});
