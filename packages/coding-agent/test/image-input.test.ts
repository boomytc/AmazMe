import assert from "node:assert/strict";
import test from "node:test";
import { refuseImageTurn } from "../src/tui/run.ts";

const image = [{ type: "image" }];

test("deepseek-flash is refused before the turn is sent", () => {
  const models = {
    getModel(provider: string, modelId: string) {
      if (provider === "deepseek" && modelId === "deepseek-flash") return { id: "deepseek-flash", input: ["text"] };
      if (provider === "compat" && modelId === "see") return { id: "see", input: ["text", "image"] };
      return undefined;
    },
  };
  assert.equal(
    refuseImageTurn(models, "deepseek", "deepseek-flash", image),
    "Model deepseek-flash does not accept image input",
  );
  assert.equal(refuseImageTurn(models, "compat", "see", image), undefined);
  assert.equal(refuseImageTurn(models, "compat", "see", [{ type: "text" }]), undefined);
  assert.equal(refuseImageTurn(models, "missing", "nope", image), "未知模型 missing/nope");
});
