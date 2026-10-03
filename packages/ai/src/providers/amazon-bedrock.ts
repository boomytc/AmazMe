import { access } from "node:fs/promises";
import type { ApiKeyAuth } from "../auth.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

/**
 * Detect a bearer token or an existing AWS chain. Secrets stay in the environment.
 * The request path sends only a bearer; this cut does not sign with the AWS SDK.
 */
function bedrockAuth(): ApiKeyAuth {
  return {
    env: "AWS_BEARER_TOKEN_BEDROCK",
    name: "AWS credentials or bearer token",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      if (credential?.key) return { apiKey: credential.key, source: "store", ...(credential.env ? { env: credential.env } : {}) };
      const bearer = env.AWS_BEARER_TOKEN_BEDROCK;
      if (bearer) return { apiKey: bearer, source: "env" };
      const profile = credential?.env?.AWS_PROFILE ?? env.AWS_PROFILE;
      if (profile) return { source: credential?.env?.AWS_PROFILE ? "store" : "env", env: { AWS_PROFILE: profile } };
      if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return { source: "env" };
      if (env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI || env.AWS_CONTAINER_CREDENTIALS_FULL_URI || env.AWS_WEB_IDENTITY_TOKEN_FILE) {
        return { source: "env" };
      }
      if (await fileExists(env.AWS_SHARED_CREDENTIALS_FILE) || await fileExists(env.AWS_CONFIG_FILE)) return { source: "env" };
      return undefined;
    },
  };
}

async function fileExists(path: string | undefined): Promise<boolean> {
  if (!path) return false;
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export function amazonBedrockProvider(options: { fetch?: typeof fetch } = {}): Provider {
  return createProvider({
    id: "amazon-bedrock",
    name: "Amazon Bedrock",
    auth: { apiKey: bedrockAuth() },
    models: catalogModels("amazon-bedrock"),
    api: wires("bedrock-converse-stream", options),
  });
}
