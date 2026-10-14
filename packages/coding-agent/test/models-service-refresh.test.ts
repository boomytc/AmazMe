import type { ModelsRefreshResult } from "@amazme/ai";
import { replicatedState } from "@amazme/chord";
import { BACKGROUND_CONTEXT as context, withAbortSignal } from "@amazme/chord/context";
import { describe, expect, it, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";
import { createModelsService } from "../src/host/services/models-provider.ts";

const result = (): ModelsRefreshResult => ({ aborted: false, errors: new Map() });
async function setup() {
	const modelRuntime = await ModelRuntime.create({ credentials: AuthStorage.inMemory(), modelsPath: null, refreshOnCreate: false });
	const runtime = createModelsService(async () => { throw new Error("No conversation action expected"); },
		() => undefined, modelRuntime, undefined, replicatedState);
	await runtime.activate(context);
	return { runtime, service: runtime.service, modelRuntime };
}

describe("model catalog refresh ownership", () => {
	it("shares one refresh without clearing the available catalog; a cancelled waiter leaves other readers running", async () => {
		const { runtime, service, modelRuntime } = await setup();
		const gate = Promise.withResolvers<ModelsRefreshResult>();
		const refresh = vi.spyOn(modelRuntime, "refresh").mockReturnValue(gate.promise);
		const controller = new AbortController();
		const catalog = service.state.value?.catalog;
		const first = service.refresh(withAbortSignal(controller.signal, context));
		const second = service.refresh(context);
		const stopped = first.catch(error => error);
		try {
			await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
			expect(refresh).toHaveBeenCalledTimes(1);
			expect(service.state.value?.catalog).toEqual(catalog);
			expect(service.state.value?.refresh.status).toBe("refreshing");
			controller.abort(new Error("reader left"));
			expect(await stopped).toMatchObject({ message: "reader left" });
			expect(refresh.mock.calls[0]?.[0]?.signal?.aborted).toBe(false);
			expect(service.state.value?.refresh.status).toBe("refreshing");
			gate.resolve(result());
			await second;
			expect(service.state.value?.refresh.status).toBe("done");
		} finally {
			gate.resolve(result());
			await Promise.allSettled([first, second]);
			await runtime.close();
		}
	});

	it("settles a failed refresh and permits a later retry", async () => {
		const { runtime, service, modelRuntime } = await setup();
		const error = new Error("catalog unavailable");
		const refresh = vi.spyOn(modelRuntime, "refresh").mockRejectedValueOnce(error).mockResolvedValue(result());
		try {
			await expect(service.refresh(context)).rejects.toBe(error);
			expect(service.state.value?.refresh).toEqual({ status: "warning", errors: { catalog: "catalog unavailable" } });
			await service.refresh(context);
			expect(refresh).toHaveBeenCalledTimes(2);
			expect(service.state.value?.refresh.status).toBe("done");
		} finally { await runtime.close(); }
	});

	it("does not start provider work if a state observer closes the service", async () => {
		const { runtime, service, modelRuntime } = await setup();
		const refresh = vi.spyOn(modelRuntime, "refresh").mockResolvedValue(result());
		let closing: Promise<void> | undefined;
		const stop = service.state.subscribe(value => {
			if (value.refresh.status === "refreshing") closing = runtime.close();
		});
		try {
			await expect(service.refresh(context)).rejects.toThrow("Models service closed");
			await closing;
			expect(refresh).not.toHaveBeenCalled();
		} finally { stop(); await runtime.close(); }
	});

	it("cancels and joins its refresh on close without publishing a late catalog", async () => {
		const { runtime, service, modelRuntime } = await setup();
		const gate = Promise.withResolvers<ModelsRefreshResult>();
		const refresh = vi.spyOn(modelRuntime, "refresh").mockReturnValue(gate.promise);
		const pending = service.refresh(context);
		const settled = pending.catch(error => error);
		try {
			await vi.waitFor(() => expect(refresh).toHaveBeenCalled());
			const beforeClose = service.state.value;
			let closed = false;
			const closing = runtime.close().then(() => { closed = true; });
			expect(refresh.mock.calls[0]?.[0]?.signal?.aborted).toBe(true);
			await Promise.resolve();
			expect(closed).toBe(false);
			gate.resolve(result());
			await closing;
			expect(await settled).toBeInstanceOf(Error);
			expect(service.state.value).toEqual(beforeClose);
			await expect(service.refresh(context)).rejects.toThrow();
			expect(refresh).toHaveBeenCalledTimes(1);
		} finally {
			gate.resolve(result());
			await settled;
			await runtime.close();
		}
	});
});
