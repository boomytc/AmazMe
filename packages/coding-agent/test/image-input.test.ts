import assert from "node:assert/strict";
import test from "node:test";
import { createModels } from "@amazme/ai";
import { deepseekProvider } from "@amazme/ai/providers/deepseek";
import { refuseImageTurn } from "../src/tui/run.ts";

const image = [{ type: "image" }];

// Catalog input is text only. Refusal follows model.input. Do not reject by model id,
// and do not rewrite flash input in a fixture.
test("deepseek-flash and deepseek-v4-pro are refused before the turn is sent", () => {
  const models = createModels();
  models.setProvider(deepseekProvider());
  const flash = models.getModel("deepseek", "deepseek-flash");
  const pro = models.getModel("deepseek", "deepseek-v4-pro");
  assert.ok(flash);
  assert.ok(pro);
  assert.deepEqual(flash.input, ["text"]);
  assert.deepEqual(pro.input, ["text"]);
  assert.equal(
    refuseImageTurn(models, "deepseek", "deepseek-flash", image),
    "Model deepseek-flash does not accept image input",
  );
  assert.equal(
    refuseImageTurn(models, "deepseek", "deepseek-v4-pro", image),
    "Model deepseek-v4-pro does not accept image input",
  );
  assert.equal(refuseImageTurn(models, "deepseek", "deepseek-flash", [{ type: "text" }]), undefined);
  assert.equal(refuseImageTurn(models, "deepseek", "deepseek-v4-pro", [{ type: "text" }]), undefined);
  assert.equal(refuseImageTurn(models, "missing", "nope", image), "未知模型 missing/nope");
});
