/**
 * Test helper for resolving API keys from ~/.amazme/agent/auth.json
 *
 * Supports both API key and OAuth credentials.
 * OAuth tokens are automatically refreshed if expired and saved back to auth.json.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { OAuthCredentials } from "../src/auth/types.ts";
import { builtinProviders } from "../src/providers/all.ts";

const AUTH_PATH = join(homedir(), ".amazme", "agent", "auth.json");

type ApiKeyCredential = {
	type: "api_key";
	key: string;
};

type OAuthCredentialEntry = {
	type: "oauth";
} & OAuthCredentials;

type AuthCredential = ApiKeyCredential | OAuthCredentialEntry;

type AuthStorage = Record<string, AuthCredential>;

function loadAuthStorage(authPath: string): AuthStorage {
	if (!existsSync(authPath)) {
		return {};
	}
	const content = readFileSync(authPath, "utf-8");
	return JSON.parse(content) as AuthStorage;
}

function saveAuthStorage(authPath: string, storage: AuthStorage): void {
	const configDir = dirname(authPath);
	if (!existsSync(configDir)) {
		mkdirSync(configDir, { recursive: true, mode: 0o700 });
	}
	// Readers in other Vitest workers must never observe a truncated JSON file.
	const temporaryDir = mkdtempSync(join(configDir, ".auth-test-"));
	try {
		const temporaryPath = join(temporaryDir, "auth.json");
		writeFileSync(temporaryPath, JSON.stringify(storage, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(temporaryPath, authPath);
	} finally {
		rmSync(temporaryDir, { recursive: true, force: true });
	}
}

/**
 * Resolve API key for a provider from ~/.amazme/agent/auth.json
 *
 * For API key credentials, returns the key directly.
 * For OAuth credentials, returns the access token (refreshing if expired and saving back).
 *
 */
export async function resolveApiKey(provider: string, authPath = AUTH_PATH): Promise<string | undefined> {
	const storage = loadAuthStorage(authPath);
	const entry = storage[provider];

	if (!entry) return undefined;

	if (entry.type === "api_key") {
		return entry.key;
	}

	if (entry.type === "oauth") {
		const oauth = builtinProviders().find((candidate) => candidate.id === provider)?.auth.oauth;
		if (!oauth) throw new Error(`No OAuth implementation for configured test provider: ${provider}`);
		let credential = entry;
		if (Date.now() >= credential.expires) {
			credential = await oauth.refresh(credential, new AbortController().signal);
			// Preserve credentials changed while the refresh request was in flight.
			saveAuthStorage(authPath, { ...loadAuthStorage(authPath), [provider]: credential });
		}
		return (await oauth.toAuth(credential)).apiKey;
	}

	return undefined;
}
