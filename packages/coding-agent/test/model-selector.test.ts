import type { Model, ModelsRefreshResult } from "@amazme/ai";
import { setKeybindings, type TUI } from "@amazme/tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRuntime } from "../src/core/model-runtime.ts";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ModelSelectorComponent } from "../src/modes/interactive/components/model-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

function createFakeTui(): TUI {
	return { requestRender: () => {} } as unknown as TUI;
}

function fixtureModel(id: string, name = id): Model<"openai-completions"> {
	return {
		id,
		name,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "http://127.0.0.1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8000,
		maxTokens: 1000,
	};
}

function catalog(models: readonly Model<"openai-completions">[]): ModelRuntime {
	const runtime = {
		getAvailableSnapshot: () => models,
		getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
		getError: () => undefined,
		refresh: async (): Promise<ModelsRefreshResult> => ({ aborted: false, errors: new Map() }),
	};
	return runtime as ModelRuntime;
}

describe("model selector", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the current model marked while browsing", () => {
		const currentModel = fixtureModel("current-model", "Current Model");
		const browsedModel = fixtureModel("browsed-model", "Browsed Model");
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			catalog([currentModel, browsedModel]),
			[],
			() => {},
			() => {},
		);

		const getModelRow = (id: string): string | undefined =>
			stripAnsi(selector.render(120).join("\n"))
				.split("\n")
				.find((line) => line.includes(`${id} [`))
				?.trimEnd();

		expect(getModelRow("current-model")).toBe(`→ ✓ current-model [${currentModel.provider}]`);
		selector.handleInput("\x1b[B");
		expect(getModelRow("current-model")).toBe(`  ✓ current-model [${currentModel.provider}]`);
		expect(getModelRow("browsed-model")).toBe(`→   browsed-model [${currentModel.provider}]`);
		selector.dispose();
	});

	it("uses the configured save binding", () => {
		setKeybindings(new KeybindingsManager({ "app.models.save": "ctrl+r" }));
		const currentModel = fixtureModel("current-model", "Current Model");
		const saveDefault = vi.fn();
		const selector = new ModelSelectorComponent(
			createFakeTui(),
			currentModel,
			catalog([currentModel]),
			[],
			() => {},
			() => {},
			undefined,
			saveDefault,
		);

		expect(stripAnsi(selector.render(120).join("\n"))).toContain("Ctrl+R to set as default");
		selector.handleInput("\x13");
		expect(saveDefault).not.toHaveBeenCalled();
		selector.handleInput("\x12");
		expect(saveDefault).toHaveBeenCalledWith(currentModel);
		selector.dispose();
	});

	it("lists every catalog that failed to refresh", async () => {
		const currentModel = fixtureModel("current-model", "Current Model");
		const runtime = catalog([currentModel]);
		vi.spyOn(runtime, "refresh").mockResolvedValue({
			aborted: false,
			errors: new Map([
				["openai", new Error("unavailable")],
				["anthropic", new Error("unavailable")],
			]),
		});

		const selector = new ModelSelectorComponent(createFakeTui(), currentModel, runtime, [], () => {}, () => {});

		await vi.waitFor(() => {
			const rendered = stripAnsi(selector.render(120).join("\n"));
			expect(rendered).toContain("Could not refresh 2 model catalogs (openai, anthropic); showing cached models.");
		});
		selector.dispose();
	});
});
