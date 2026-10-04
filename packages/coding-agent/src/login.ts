import { type OAuthLoginHandback } from "@amazme/ai";
import { builtinProviders } from "@amazme/ai/providers/builtin";
import { FileCredentialStore, installationDeviceId } from "./credentials.ts";

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
