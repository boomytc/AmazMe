import type { ApiKeyAuth } from "../auth.ts";
import { awsRequestEnv } from "../api/aws-chain.ts";
import { createProvider, type Provider } from "../models.ts";
import type { AuthResult } from "../types.ts";
import { catalogModels } from "./catalog.ts";
import { wires } from "./wires.ts";

/**
 * Bearer token, or a profile / credential-chain pointer.
 * Signing happens on the request. Secrets from credential files are not copied here,
 * and nothing this resolver returns is written to the credential store.
 */
function bedrockAuth(): ApiKeyAuth {
  return {
    env: "AWS_BEARER_TOKEN_BEDROCK",
    name: "AWS credentials or bearer token",
    async resolve({ credential, env }): Promise<AuthResult | undefined> {
      if (credential?.key) return { apiKey: credential.key, source: "store", ...(credential.env ? { env: credential.env } : {}) };
      const selected: Record<string, string | undefined> = credential?.env ? { ...env, ...credential.env } : { ...env };
      const profileLocked = Boolean(credential?.env?.AWS_PROFILE || credential?.env?.AWS_SHARED_CREDENTIALS_FILE || credential?.env?.AWS_CONFIG_FILE);
      if (profileLocked) delete selected.AWS_BEARER_TOKEN_BEDROCK;
      const requestEnv = await awsRequestEnv(selected, profileLocked ? "profile" : "chain");
      if (!requestEnv) return undefined;
      if (requestEnv.AWS_BEARER_TOKEN_BEDROCK) return { apiKey: requestEnv.AWS_BEARER_TOKEN_BEDROCK, source: credential ? "store" : "env" };
      return { source: credential ? "store" : "env", env: requestEnv };
    },
  };
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
