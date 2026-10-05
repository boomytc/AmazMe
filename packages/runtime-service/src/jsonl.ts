import { AgentHarness, compactionReserve, type HarnessOptions } from "@amazme/durable";
import { openJsonlOwner, type JsonlOwner } from "@amazme/durable/storage/jsonl/node";
import type { OwnedRuntimeResources } from "./server.ts";

/**
 * Open one JSONL-backed runtime. The path and inode locks are held before the file is repaired.
 * `closeStorage` waits for admitted storage work and keeps the locks. `remove` deletes that inode and
 * only then unlocks. `release` unlocks without deleting. A throw from the harness constructor releases
 * the locks before it propagates. Do not await these methods from inside a storage callback.
 * Omitted `compaction` is enabled here. The input trigger is the current model's `contextWindow`
 * minus {@link compactionReserve}. A caller-supplied `compaction` is kept. A missing model, or a
 * remainder that is not a positive integer, leaves the harness default in place.
 */
export async function openJsonlRuntime(file: string, options: HarnessOptions): Promise<OwnedRuntimeResources> {
  const owner = openJsonlOwner(file);
  try {
    return resourcesOf(owner, new AgentHarness(owner.storage, withHostCompaction(options)));
  } catch (error) {
    try {
      await owner.release();
    } catch (cause) {
      throw new AggregateError([error, cause], "opening the runtime failed and releasing the lock failed");
    }
    throw error;
  }
}

function withHostCompaction(options: HarnessOptions): HarnessOptions {
  if (options.compaction) return options;
  const model = options.models.getModel(options.model.provider, options.model.modelId);
  if (!model) return options;
  const maxTokens = model.contextWindow - compactionReserve(model.contextWindow);
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) return options;
  return { ...options, compaction: { enabled: true, maxTokens } };
}

function resourcesOf(owner: JsonlOwner, harness: AgentHarness): OwnedRuntimeResources {
  return {
    harness,
    closeStorage: () => owner.close(),
    async remove() {
      await owner.deleteData();
      await owner.release();
    },
    release: () => owner.release(),
  };
}
