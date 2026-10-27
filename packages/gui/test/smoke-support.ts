import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
export function electronBinary(): string {
	const value: unknown = require("electron");
	if (typeof value !== "string" || value.length === 0) throw new Error("electron did not resolve to a binary path");
	return value;
}

export function smokeEnvironment(scratch: string): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined && !/KEY|TOKEN|PASSWORD|SECRET|CREDENTIAL|^AWS_|^AZURE_|^GOOGLE_|^ELECTRON_RUN_AS_NODE$/iu.test(key)) env[key] = value;
	}
	return { ...env, AMAZME_GUI_SMOKE: "1", AMAZME_GUI_SMOKE_DATA_DIR: scratch,
		AMAZME_GUI_CWD: scratch,
		AMAZME_SERVER_DIR: join(scratch, "server"), AMAZME_CODING_AGENT_DIR: join(scratch, "agent"),
		AMAZME_GUI_READY_TIMEOUT_MS: "120000" };
}
