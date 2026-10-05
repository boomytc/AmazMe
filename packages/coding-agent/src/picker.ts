import { visibleModelSpec } from "@amazme/tui";

/** Jev is a classifier. Chat ids that contain it stay out of `/model`. */
export function visibleModel(model: { provider: string; id: string }): boolean {
  return visibleModelSpec(`${model.provider}/${model.id}`);
}

export function visibleModels<T extends { provider: string; id: string }>(models: readonly T[]): T[] {
  return models.filter(visibleModel);
}
