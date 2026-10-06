import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HStack } from "../src/components/h-stack.ts";
import { Text } from "../src/components/text.ts";
import { VStack } from "../src/components/v-stack.ts";
import type { Component } from "../src/tui.ts";
import { TuiAltScreen } from "../src/tui-alt-screen.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

function fixture() {
	const terminal = new VirtualTerminal(40, 8);
	const tui = new TuiAltScreen(terminal);
	let hovered = false;
	let leaves = 0;
	const header: Component = {
		render: () => [hovered ? "hovered" : "idle"],
		invalidate() {},
		handleMouse(event) {
			if (event.type !== "move") return undefined;
			const changed = !hovered;
			hovered = true;
			return { handled: true, render: changed };
		},
		handleMouseLeave() {
			leaves += 1;
			const changed = hovered;
			hovered = false;
			return changed;
		},
	};
	const owner = new Text("body", 0, 0);
	tui.setLayoutRoot(
		new VStack([
			{
				component: new HStack([
					{ component: header, basis: 20 },
					{ component: new Text("side", 0, 0), basis: 20 },
				]),
				basis: 1,
			},
			{ component: owner, grow: 1, basis: 0 },
		]),
	);
	tui.setFocus(owner);
	tui.start();
	const enter = async () => {
		terminal.sendInput("\x1b[<35;2;1M");
		await terminal.waitForRender();
		assert.equal(hovered, true);
	};
	return {
		terminal,
		tui,
		owner,
		enter,
		hovered: () => hovered,
		leaves: () => leaves,
	};
}

describe("component hover lifecycle", () => {
	it("clears hover on horizontal and vertical exits, including unhandled targets, without changing keyboard focus", async () => {
		const f = fixture();
		try {
			await f.terminal.waitForRender();
			await f.enter();
			f.terminal.sendInput("\x1b[<35;3;1M");
			assert.equal(f.leaves(), 0);
			for (const move of ["\x1b[<35;25;1M", "\x1b[<35;2;2M", "\x1b[<35;2;8M"]) {
				await f.enter();
				const before = f.leaves();
				f.terminal.sendInput(move);
				await f.terminal.waitForRender();
				assert.equal(f.hovered(), false);
				assert.equal(f.leaves(), before + 1);
				assert.ok(f.terminal.getViewport()[0]?.includes("idle"));
				assert.equal(f.tui.getFocusedComponent(), f.owner);
				f.terminal.sendInput(move);
				assert.equal(f.leaves(), before + 1);
			}
		} finally {
			f.tui.stop();
		}
	});

	it("clears a covered target when a non-interactive overlay receives pointer movement", async () => {
		const f = fixture();
		try {
			await f.terminal.waitForRender();
			await f.enter();
			const overlay = f.tui.showOverlay(new Text("overlay", 0, 0), {
				anchor: "top-left",
				width: 20,
			});
			await f.terminal.waitForRender();
			const focus = f.tui.getFocusedComponent();
			f.terminal.sendInput("\x1b[<35;2;1M");
			await f.terminal.waitForRender();
			assert.equal(f.hovered(), false);
			assert.equal(f.leaves(), 1);
			assert.equal(f.tui.getFocusedComponent(), focus);
			overlay.hide();
		} finally {
			f.tui.stop();
		}
	});

	it("clears hover on focus loss and root replacement", async () => {
		const f = fixture();
		try {
			await f.terminal.waitForRender();
			await f.enter();
			f.terminal.sendInput("\x1b[O");
			await f.terminal.waitForRender();
			assert.equal(f.hovered(), false);
			assert.equal(f.leaves(), 1);
			await f.enter();
			f.tui.setLayoutRoot(new Text("new root", 0, 0));
			await f.terminal.waitForRender();
			assert.equal(f.hovered(), false);
			assert.equal(f.leaves(), 2);
		} finally {
			f.tui.stop();
		}
	});

	it("clears hover at shutdown without leaving it on a reusable component", async () => {
		const f = fixture();
		await f.terminal.waitForRender();
		await f.enter();
		f.tui.stop();
		assert.equal(f.hovered(), false);
		assert.equal(f.leaves(), 1);
	});
});
