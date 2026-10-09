import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { findEnvKeys } from "@amazme/ai/utils/api-key-env";
import { getBuiltinProviders } from "@amazme/ai/providers/all";
import {
	CONFIG_DIR_NAME,
	getExportTemplateDir,
	getThemesDir,
} from "../config.ts";
import { loadMcpConfig } from "../extensions/mcp/config.ts";
import { resolvePath } from "../utils/paths.ts";
import { stripBom } from "../utils/text.ts";
import { ReadOnlyAuthStorage } from "./auth-storage.ts";
import type {
	DiagnosticCode,
	DiagnosticEntry,
	DiagnosticReport,
} from "./diagnostics-types.ts";
import { ModelConfig } from "./model-config.ts";
import { validateThemeJson } from "../modes/interactive/theme/theme-json.ts";
import {
	isCommandConfigValue,
	isConfigValueConfigured,
} from "./resolve-config-value.ts";
import { SettingsManager, type SettingsScope } from "./settings-manager.ts";
import { ProjectTrustStore } from "./trust-manager.ts";

export interface DiagnosticOptions {
	readonly cwd: string;
	readonly agentDir: string;
	readonly host?: {
		readonly id: string;
		readonly directory: string;
		readonly sessionDir: string;
	};
	readonly projectTrusted?: boolean;
	readonly resources?: readonly string[];
}

function readStatus(path: string): "readable" | "missing" | "unreadable" {
	try {
		accessSync(path, constants.R_OK);
		return "readable";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT"
			? "missing"
			: "unreadable";
	}
}

/** Only these explicitly constructed facts leave the process. Never return config values or error messages. */
export async function collectDiagnostics(
	options: DiagnosticOptions,
): Promise<DiagnosticReport> {
	const { cwd, agentDir } = options;
	const entries: DiagnosticEntry[] = [];
	const add = (
		area: DiagnosticEntry["area"],
		target: string,
		code: DiagnosticCode,
		level: DiagnosticEntry["level"] = "info",
	): void => {
		entries.push({
			area,
			target: target.replace(/[\u0000-\u001f\u007f-\u009f]/g, ""),
			code,
			level,
		});
	};
	const file = (
		area: DiagnosticEntry["area"],
		path: string,
	): ReturnType<typeof readStatus> => {
		const status = readStatus(path);
		add(area, path, status, status === "unreadable" ? "error" : "info");
		return status;
	};
	const invalid = (area: DiagnosticEntry["area"], path: string): void => {
		const entry = entries.findIndex(
			(value) => value.area === area && value.target === path,
		);
		if (entry >= 0) entries.splice(entry, 1);
		add(area, path, "invalid", "error");
	};
	const directory = (
		area: DiagnosticEntry["area"],
		path: string,
		writable: boolean,
	): void => {
		const status = file(area, path);
		if (status !== "readable") return;
		try {
			if (!statSync(path).isDirectory()) {
				add(area, path, "notDirectory", "error");
				return;
			}
			accessSync(path, constants.R_OK | constants.X_OK);
			if (writable) accessSync(path, constants.W_OK | constants.X_OK);
		} catch {
			add(area, path, writable ? "notWritable" : "unreadable", "error");
		}
	};

	const [major, minor] = process.versions.node.split(".").map(Number);
	const supportedRuntime =
		major > 22 || (major === 22 && minor >= 19) || !!process.versions.bun;
	add(
		"host",
		`Node.js ${process.versions.node} (${process.platform}/${process.arch})`,
		supportedRuntime ? "readable" : "unsupportedNode",
		supportedRuntime ? "info" : "error",
	);
	add(
		"host",
		options.host?.id ?? "Unix host",
		options.host ? "hostRunning" : "hostUnchecked",
	);
	const hostDir =
		options.host?.directory ??
		resolvePath(
			process.env.AMAZME_SERVER_DIR ??
				join(homedir(), CONFIG_DIR_NAME, "server"),
		);
	directory("host", hostDir, true);
	directory("storage", agentDir, true);
	directory(
		"storage",
		options.host?.sessionDir ?? join(agentDir, "sessions"),
		true,
	);
	add("storage", "Session databases", "integrityUnchecked");
	for (const name of ["models-store.json", "feedback.json"]) {
		const path = join(agentDir, name);
		if (file("storage", path) !== "readable") continue;
		try {
			const value: unknown = JSON.parse(stripBom(readFileSync(path, "utf8")));
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new Error();
			if (
				name === "feedback.json" &&
				!Array.isArray((value as Record<string, unknown>).records)
			)
				throw new Error();
		} catch {
			invalid("storage", path);
		}
	}

	const trustPath = join(agentDir, "trust.json");
	const trustStatus = file("config", trustPath);
	let trusted = options.projectTrusted ?? false;
	let savedTrust: boolean | undefined;
	if (trustStatus !== "unreadable") {
		try {
			savedTrust = new ProjectTrustStore(agentDir).getEntryReadOnly(
				cwd,
			)?.decision;
			trusted = options.projectTrusted ?? savedTrust === true;
		} catch {
			invalid("config", trustPath);
		}
	}
	const settingsPaths: Record<SettingsScope, string> = {
		global: join(agentDir, "settings.json"),
		project: join(cwd, CONFIG_DIR_NAME, "settings.json"),
	};
	const contents = new Map<SettingsScope, string>();
	for (const scope of ["global", "project"] as const) {
		const path = settingsPaths[scope];
		if (scope === "project" && !trusted) {
			add("config", path, "untrusted");
			continue;
		}
		if (file("config", path) !== "readable") continue;
		try {
			const content = readFileSync(path, "utf8");
			const parsed: unknown = JSON.parse(stripBom(content));
			if (
				typeof parsed !== "object" ||
				parsed === null ||
				Array.isArray(parsed)
			)
				throw new Error();
			// Guard just the fields this observation consumes; SettingsManager remains the settings parser.
			const value = parsed as Record<string, unknown>;
			for (const key of ["extensions", "skills", "prompts", "themes"]) {
				if (
					value[key] !== undefined &&
					(!Array.isArray(value[key]) ||
						!value[key].every((path: unknown) => typeof path === "string"))
				)
					throw new Error();
			}
			if (
				value.defaultProvider !== undefined &&
				typeof value.defaultProvider !== "string"
			)
				throw new Error();
			contents.set(scope, content);
			if (
				scope === "global" &&
				options.projectTrusted === undefined &&
				savedTrust === undefined &&
				value.defaultProjectTrust === "always"
			)
				trusted = true;
		} catch {
			invalid("config", path);
		}
	}
	const settings = SettingsManager.fromStorage(
		{
			withLock(scope, read) {
				if (read(contents.get(scope)) !== undefined)
					throw new Error("Diagnostic settings cannot be written");
			},
		},
		{ projectTrusted: trusted },
	);
	for (const error of settings.drainErrors())
		invalid("config", settingsPaths[error.scope]);

	const modelsPath = join(agentDir, "models.json");
	const modelStatus = file("config", modelsPath);
	const models = await ModelConfig.load(
		modelStatus === "readable" ? modelsPath : undefined,
	);
	if (models.getError()) invalid("config", modelsPath);
	const authPath = join(agentDir, "auth.json");
	const authStatus = file("auth", authPath);
	const auth = new ReadOnlyAuthStorage(authPath);
	const providers = new Set(models.getProviderIds());
	const defaultProvider = settings.getDefaultProvider();
	if (defaultProvider) providers.add(defaultProvider);
	if (authStatus === "readable") {
		try {
			for (const info of await auth.list()) {
				providers.add(info.providerId);
				const credential = await auth.read(info.providerId);
				const scopedEnv =
					credential?.type === "api_key" ? credential.env : undefined;
				const scopedKeyConfigured =
					scopedEnv &&
					findEnvKeys(info.providerId, scopedEnv)?.some(
						(name) => !!scopedEnv[name],
					);
				let code: DiagnosticCode = "unconfigured";
				if (credential?.type === "oauth") {
					code =
						credential.expires <= Date.now() ? "oauthExpired" : "configured";
				} else if (credential?.key) {
					code = isCommandConfigValue(credential.key)
						? "commandDeferred"
						: "configured";
				} else if (scopedKeyConfigured) {
					code = "configured";
				}
				add(
					"auth",
					`${info.providerId} (auth.json)`,
					code,
					code === "oauthExpired" || code === "unconfigured"
						? "warning"
						: "info",
				);
			}
		} catch {
			invalid("auth", authPath);
		}
	}
	for (const id of new Set([
		...getBuiltinProviders(),
		"radius",
		...providers,
	])) {
		if (findEnvKeys(id)?.length) {
			providers.add(id);
			add("auth", `${id} (environment)`, "configured");
		}
	}
	for (const id of providers) {
		const key = models.getProvider(id)?.apiKey;
		if (key !== undefined) {
			const code = isCommandConfigValue(key)
				? "commandDeferred"
				: isConfigValueConfigured(key)
					? "configured"
					: "unconfigured";
			add(
				"auth",
				`${id} (models.json)`,
				code,
				code === "unconfigured" ? "warning" : "info",
			);
		}
		if (id === "amazon-bedrock" || id === "google-vertex")
			add("auth", id, "ambientUnchecked");
		else if (
			!entries.some(
				(entry) => entry.area === "auth" && entry.target.startsWith(`${id} (`),
			)
		) {
			add(
				"auth",
				id,
				models.getProvider(id) ? "requestAuthUnchecked" : "unconfigured",
				models.getProvider(id) ? "info" : "warning",
			);
		}
	}
	if (providers.size === 0)
		add(
			"auth",
			defaultProvider ?? "Provider credentials",
			"unconfigured",
			"warning",
		);

	for (const path of [
		join(agentDir, "mcp.json"),
		...(trusted ? [join(cwd, CONFIG_DIR_NAME, "mcp.json")] : []),
	])
		file("mcp", path);
	if (!trusted) add("mcp", join(cwd, CONFIG_DIR_NAME, "mcp.json"), "untrusted");
	const mcp = loadMcpConfig({ agentDir, cwd, projectTrusted: trusted });
	if (mcp.errors.length) add("mcp", "mcp.json", "invalid", "error");
	for (const server of mcp.servers)
		add(
			"mcp",
			server.name,
			server.config.enabled === false ? "disabled" : "configured",
		);

	for (const path of [
		join(getThemesDir(), "dark.json"),
		join(getThemesDir(), "light.json"),
		join(getExportTemplateDir(), "template.html"),
		join(getExportTemplateDir(), "template.css"),
		join(getExportTemplateDir(), "template.js"),
		join(getExportTemplateDir(), "vendor", "highlight.min.js"),
		join(getExportTemplateDir(), "vendor", "marked.min.js"),
		...(options.resources ?? []),
	]) {
		const status = file("resources", path);
		if (status === "missing")
			entries[entries.length - 1] = {
				...entries[entries.length - 1],
				level: "error",
			};
		if (
			status === "readable" &&
			(path === join(getThemesDir(), "dark.json") ||
				path === join(getThemesDir(), "light.json"))
		) {
			try {
				validateThemeJson(
					path,
					JSON.parse(stripBom(readFileSync(path, "utf8"))),
				);
			} catch {
				invalid("resources", path);
			}
		}
	}
	for (const [configured, base] of [
		[settings.getGlobalSettings(), agentDir],
		[settings.getProjectSettings(), join(cwd, CONFIG_DIR_NAME)],
	] as const) {
		for (const path of [
			...(configured.extensions ?? []),
			...(configured.skills ?? []),
			...(configured.prompts ?? []),
			...(configured.themes ?? []),
		]) {
			if (path.startsWith("!") || /[*?\[\]{}]/.test(path)) {
				add("resources", "Resource pattern", "patternUnchecked");
				continue;
			}
			const status = file("resources", resolvePath(path, base));
			if (status === "missing")
				entries[entries.length - 1] = {
					...entries[entries.length - 1],
					level: "warning",
				};
		}
	}
	// A missing agent directory must be creatable by normal startup, but diagnostics never create it.
	if (readStatus(agentDir) === "missing") {
		let parent = dirname(agentDir);
		while (readStatus(parent) === "missing" && dirname(parent) !== parent)
			parent = dirname(parent);
		directory("storage", parent, true);
	}
	return { version: 1, generatedAt: Date.now(), entries };
}
