import { type OAuthLoginHandback } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { addScopedModels } from "@amazme/tui";
import { FileCredentialStore, installationDeviceId } from "./credentials.ts";
import { visibleModel } from "./picker.ts";

export interface LoginReport {
  provider: string;
  credentialType: string;
  message: string;
}

/** The same OAuth path as `amazme login`. The credential file is read again on the next model request. */
export async function loginProvider(providerId: string, options: {
  method?: "pkce" | "device_code";
  callbackPort?: number;
  credentialsFile?: string;
  onHandback?: (handback: OAuthLoginHandback) => void;
} = {}): Promise<LoginReport> {
  if (!providerId) throw new Error("login requires --provider");
  const provider = builtinProviders().find((item) => item.id === providerId);
  if (!provider?.auth.oauth) throw new Error(`${providerId} has no login`);
  const result = await provider.auth.oauth.login({
    ...(options.method ? { method: options.method } : {}),
    ...(options.callbackPort !== undefined && Number.isInteger(options.callbackPort) ? { callbackPort: options.callbackPort } : {}),
    deviceId: installationDeviceId(),
    ...(options.onHandback ? { onHandback: options.onHandback } : {}),
  });
  await new FileCredentialStore(options.credentialsFile).set(provider.id, result.credential);
  return { provider: provider.id, credentialType: result.credential.type, message: `已保存 ${provider.id}` };
}

export interface ProviderCatalogEntry {
  id: string;
  name: string;
  stored: boolean;
  storedType: "oauth" | "api_key" | null;
  oauth: boolean;
  apiKey: boolean;
}

/** Builtin providers the fullscreen login list can show. Faux is not a login target. */
export async function loginCatalog(credentialsFile?: string): Promise<ProviderCatalogEntry[]> {
  const store = new FileCredentialStore(credentialsFile);
  const rows: ProviderCatalogEntry[] = [];
  for (const provider of builtinProviders()) {
    if (!provider.auth.oauth && !provider.auth.apiKey) continue;
    const credential = await store.get(provider.id);
    const storedType = credential?.type === "oauth" || credential?.type === "api_key" ? credential.type : null;
    rows.push({
      id: provider.id,
      name: provider.name,
      stored: storedType !== null,
      storedType,
      oauth: provider.auth.oauth !== undefined,
      apiKey: provider.auth.apiKey !== undefined,
    });
  }
  return rows.sort((left, right) => left.name.localeCompare(right.name));
}

export async function saveApiKey(providerId: string, key: string, credentialsFile?: string): Promise<string> {
  const provider = builtinProviders().find((item) => item.id === providerId);
  if (!provider?.auth.apiKey) throw new Error(`${providerId} has no API key login`);
  if (key.length === 0) throw new Error("API key is empty");
  await new FileCredentialStore(credentialsFile).set(provider.id, { type: "api_key", key });
  return `已保存 ${provider.id}`;
}

/** Chat specs `provider/id` from `getModels()`. TypeSafe Jev is a classifier, and faux is not builtin, so both are empty. */
export function builtinModelSpecs(providerId: string): string[] {
  const provider = builtinProviders().find((item) => item.id === providerId);
  if (!provider) return [];
  return provider.getModels().filter(visibleModel).map((model) => `${provider.id}/${model.id}`);
}

/** Record the builtin chat models after a credential is stored. No workspace means nothing is written. */
export function commitProviderModels(providerId: string, cwd?: string | null, current?: string): string {
  if (!cwd) return `已保存 ${providerId}，当前没有工作区，未写入模型循环`;
  const { added } = addScopedModels(cwd, builtinModelSpecs(providerId), current);
  return `已保存 ${providerId}，模型循环加入 ${added} 个`;
}

export async function logoutProvider(providerId: string, credentialsFile?: string): Promise<string> {
  if (!providerId) throw new Error("logout requires a provider");
  await new FileCredentialStore(credentialsFile).delete(providerId);
  return `已移除 ${providerId}`;
}

export function formatHandback(handback: OAuthLoginHandback): string {
  const parts: string[] = [];
  if (handback.auth_url) parts.push(handback.auth_url);
  if (handback.device_code) parts.push(`${handback.device_code.verification_uri} ${handback.device_code.user_code}`);
  return parts.join("\n") || "等待登录";
}
