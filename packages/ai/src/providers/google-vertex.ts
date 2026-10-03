import { access } from "node:fs/promises";
import { homedir } from "node:os";
import type { ApiKeyAuth } from "../auth.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

const DEFAULT_ADC = `${homedir()}/.config/gcloud/application_default_credentials.json`;

/** API key or ADC file path, project, and location. The credential file is not copied into the store. */
function vertexAuth(): ApiKeyAuth {
  return {
    env: "GOOGLE_CLOUD_API_KEY",
    name: "Google Cloud credentials",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      if (credential?.key) return { apiKey: credential.key, source: "store", ...(credential.env ? { env: credential.env } : {}) };
      const key = env.GOOGLE_CLOUD_API_KEY;
      if (key) return { apiKey: key, source: "env" };
      const credentials = credential?.env?.GOOGLE_APPLICATION_CREDENTIALS ?? env.GOOGLE_APPLICATION_CREDENTIALS ?? DEFAULT_ADC;
      const project = credential?.env?.GOOGLE_CLOUD_PROJECT ?? env.GOOGLE_CLOUD_PROJECT ?? env.GCLOUD_PROJECT;
      const location = credential?.env?.GOOGLE_CLOUD_LOCATION ?? env.GOOGLE_CLOUD_LOCATION;
      if (project && location && await fileExists(credentials)) {
        return {
          source: credential ? "store" : "env",
          env: {
            GOOGLE_CLOUD_PROJECT: project,
            GOOGLE_CLOUD_LOCATION: location,
            GOOGLE_APPLICATION_CREDENTIALS: expandHome(credentials),
          },
        };
      }
      return undefined;
    },
  };
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? `${homedir()}${path.slice(1)}` : path;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(expandHome(path));
    return true;
  } catch {
    return false;
  }
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
