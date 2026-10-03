import { radiusOAuth } from "../auth/oauth/flows.ts";
import { createProvider, type Provider } from "../models.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

/** Static Radius catalog only. There is no dynamic model refresh. */
export function radiusProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "radius",
    name: "Radius",
    baseUrl: "https://radius.pi.dev/v1",
    auth: {
      apiKey: { env: "RADIUS_API_KEY", name: "Radius API key" },
      oauth: radiusOAuth("https://radius.pi.dev", options.fetch),
    },
    models: catalogModels("radius"),
    api: wires("pi-messages", options),
  });
}
