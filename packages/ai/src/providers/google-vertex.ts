import { homedir } from "node:os";
import type { ApiKeyAuth } from "../auth.ts";
import { adcCanAuthenticate } from "../api/google-adc.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

const DEFAULT_ADC = `${homedir()}/.config/gcloud/application_default_credentials.json`;

/**
 * API key, or project / location / ADC path. The file is read again on the request
 * so a refresh token or private key is never copied into the credential store.
 */
function vertexAuth(): ApiKeyAuth {
  return {
    env: "GOOGLE_CLOUD_API_KEY",
    name: "Google Cloud credentials",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      if (credential?.key) return { apiKey: credential.key, source: "store", ...(credential.env ? { env: credential.env } : {}) };
      const project = credential?.env?.GOOGLE_CLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
      const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? env.GOOGLE_CLOUD_LOCATION;
      if (!credential) {
        const key = env.GOOGLE_CLOUD_API_KEY;
        if (key) {
          return {
            apiKey: key,
            source: "env",
            ...((project || location) ? { env: { ...(project ? { GOOGLE_CLOUD_PROJECT: project } : {}), ...(location ? { GOOGLE_CLOUD_LOCATION: location } : {}) } } : {}),
          };
        }
      }
      const credentials = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? DEFAULT_ADC;
      const path = expandHome(credentials);
      if (!project || !location || !await adcCanAuthenticate(path)) return undefined;
      return {
        source: credential ? "store" : "env",
        env: {
          GOOGLE_CLOUD_PROJECT: project,
          GOOGLE_CLOUD_LOCATION: location,
          GOOGLE_APPLICATION_CREDENTIALS: path,
        },
      };
    },
  };
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

export function googleVertexProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "google-vertex",
    name: "Google Vertex AI",
    auth: { apiKey: vertexAuth() },
    models: catalogModels("google-vertex"),
    api: wires("google-vertex", options),
  });
}
