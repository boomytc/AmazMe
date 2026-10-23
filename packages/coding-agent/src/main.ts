/**
 * Main entry point for the coding agent CLI.
 *
 * Interactive, print, JSON, and RPC all open a Durable session.
 */

import { setTimeout as delay } from "node:timers/promises";
import { type ImageContent } from "@amazme/ai";
import chalk from "chalk";
import { type Args, normalizeSessionName, parseArgs, printHelp } from "./cli/args.ts";
import {
	type AuthCheckResult,
	checkProviderAuth,
	createAuthCheckModelRuntime,
	getProviderCredential,
} from "./cli/auth-check.ts";
import {
	type AuthCommand,
	AuthCommandError,
	getAuthCommandName,
	getAuthCommandUsage,
	isAuthCommandHelp,
	parseAuthCommand,
	printAuthCommandHelp,
	validateAuthCommandArgs,
} from "./cli/auth-command.ts";
import { resolveCredentialForPrint } from "./cli/credential-print.ts";
import { processFileArguments } from "./cli/file-processor.ts";
import { runProviderAuthCommand } from "./cli/provider-auth.ts";
import { buildInitialMessage } from "./cli/initial-message.ts";
import { listModels } from "./cli/list-models.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import { shouldRunFirstTimeSetup, showFirstTimeSetup } from "./cli/startup-ui.ts";
import { APP_COMMAND, ENV_SESSION_DIR, getAgentDir, getPackageDir, VERSION } from "./config.ts";
import { AuthStorage, ReadOnlyAuthStorage } from "./core/auth-storage.ts";
import { exportFromFile } from "./core/export-html/index.ts";
import { applyHttpProxySettings, configureHttpDispatcher } from "./core/http-dispatcher.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { restoreStdout, takeOverStdout } from "./core/output-guard.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { collectSettingsDiagnostics, type RuntimeDiagnostic } from "./core/settings-diagnostics.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { printTimings, resetTimings, time } from "./core/timings.ts";
import { ProjectTrustStore } from "./core/trust-manager.ts";
import { loadMcpCommand } from "./extensions/mcp/cli.lazy.ts";
import { resolveExplicitSession } from "./durable/sessions.ts";
import { runMigrations } from "./migrations.ts";
import { setThemeJsonValidator } from "./modes/interactive/theme/theme.ts";
import { validateThemeJson } from "./modes/interactive/theme/theme-schema.ts";
import { cleanupManagedInstall, handleConfigCommand, handlePackageCommand } from "./package-manager-cli.ts";
import { isLocalPath, resolvePath } from "./utils/paths.ts";
import { cleanupWindowsSelfUpdateQuarantine } from "./utils/windows-self-update.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

function reportDiagnostics(diagnostics: readonly RuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

function resolveAppMode(parsed: Args, stdinIsTTY: boolean, stdoutIsTTY: boolean): AppMode {
	if (parsed.mode === "rpc") {
		return "rpc";
	}
	if (parsed.mode === "json") {
		return "json";
	}
	if (parsed.print || !stdinIsTTY || !stdoutIsTTY) {
		return "print";
	}
	return "interactive";
}

function isPlainRuntimeMetadataCommand(parsed: Args): boolean {
	return !parsed.print && parsed.mode === undefined && (parsed.help === true || parsed.listModels !== undefined);
}

async function runAuthCommand(args: string[]): Promise<boolean> {
	if (isAuthCommandHelp(args)) {
		printAuthCommandHelp();
		return true;
	}

	let command: AuthCommand | undefined;
	try {
		command = parseAuthCommand(args);
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to parse auth command";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = 1;
		return true;
	}
	if (!command) return false;

	const parsed = parseArgs(command.args);
	if (parsed.unknownFlags.size > 0) {
		const option = parsed.unknownFlags.keys().next().value;
		console.error(chalk.red(`Unknown option --${option} for "${getAuthCommandName(command.kind)}".`));
		console.error(chalk.dim(`Use "${APP_COMMAND} --help" or "${getAuthCommandUsage(command.kind)}".`));
		process.exitCode = 1;
		return true;
	}
	try {
		if (parsed.diagnostics.length > 0) {
			throw new AuthCommandError(parsed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
		}
		if (command.kind === "login" || command.kind === "logout") {
			const requested = validateAuthCommandArgs(parsed, command.kind);
			await runProviderAuthCommand(command.kind, requested.provider!, command.authType);
			return true;
		}
		if (command.kind !== "check") {
			const signal = AbortSignal.timeout(15_000);
			const modelRuntime = await ModelRuntime.create({ allowModelNetwork: false, signal });
			const credential = await resolveCredentialForPrint(
				parsed,
				modelRuntime,
				command.kind,
				command.minExpiryMs,
				signal,
			);
			process.stdout.write(`${credential}\n`);
			return true;
		}

		const requestedAuth = validateAuthCommandArgs(parsed, command.kind);
		let result: AuthCheckResult;
		let credential: string | undefined;
		try {
			const credentials = command.noRefresh ? new ReadOnlyAuthStorage() : AuthStorage.create();
			const modelRuntime = await createAuthCheckModelRuntime(credentials);
			result = await checkProviderAuth(parsed, modelRuntime, { refresh: !command.noRefresh });
			if (command.credentials && result.status === "ready") {
				credential = await getProviderCredential(result.provider, modelRuntime, credentials, {
					refresh: !command.noRefresh,
				});
				if (!credential) {
					result = { status: "not_ready", provider: result.provider, reason: "credential_not_available" };
				}
			}
		} catch {
			result = {
				status: "invalid",
				provider: requestedAuth.provider ?? requestedAuth.model!,
				reason: "invalid_state",
			};
		}
		const output = command.json
			? JSON.stringify({ ...result, ...(credential ? { credentials: credential } : {}) })
			: (credential ?? result.status);
		process.stdout.write(`${output}\n`);
		process.exitCode = result.status === "ready" ? 0 : result.status === "not_ready" ? 1 : 2;
	} catch (error) {
		const message = error instanceof AuthCommandError ? error.message : "Failed to resolve credential";
		console.error(chalk.red(`Error: ${message}`));
		process.exitCode = command.kind === "check" ? 2 : 1;
	}
	return true;
}

async function prepareInitialMessage(
	parsed: Args,
	stdinContent?: string,
): Promise<{
	initialMessage?: string;
	initialImages?: ImageContent[];
}> {
	if (parsed.fileArgs.length === 0) {
		return buildInitialMessage({ parsed, stdinContent });
	}

	const { text, images } = await processFileArguments(parsed.fileArgs, { autoResizeImages: false });
	return buildInitialMessage({
		parsed,
		fileText: text,
		fileImages: images,
		stdinContent,
	});
}

function resolveCliPaths(cwd: string, paths: string[] | undefined): string[] | undefined {
	return paths?.map((value) => (isLocalPath(value) ? resolvePath(value, cwd) : value));
}


export async function main(args: string[]) {
	// Diagnostics precede install cleanup, settings locks, proxy setup, and credential initialization.
	if (args[0] === "doctor") {
		const { runDoctorCommand } = await import("./cli/doctor.ts");
		process.exitCode = await runDoctorCommand(args.slice(1), { cwd: process.cwd(), agentDir: getAgentDir() });
		return;
	}
	resetTimings();
	// Startup commands and selectors can load user-authored themes before runtime creation.
	setThemeJsonValidator(validateThemeJson);
	const offlineMode = args.includes("--offline") || isTruthyEnvFlag(process.env.AMAZME_OFFLINE);
	if (offlineMode) {
		process.env.AMAZME_OFFLINE = "1";
		process.env.AMAZME_SKIP_VERSION_CHECK = "1";
	}

	if (await runAuthCommand(args)) {
		return;
	}

	if (process.platform === "win32") {
		cleanupWindowsSelfUpdateQuarantine(getPackageDir());
	}
	cleanupManagedInstall();

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const bootstrapSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	applyHttpProxySettings(bootstrapSettingsManager.getGlobalSettings().httpProxy);
	configureHttpDispatcher();

	if (await handlePackageCommand(args)) {
		const exitCode = process.exitCode ?? 0;
		if (process.platform === "win32" && exitCode === 0 && args[0] === "update") {
			// We normally prefer process.exit(0) for package commands so bad extensions cannot keep
			// one-shot commands alive. On Windows, Node can assert after fetch() if process.exit(0)
			// runs during teardown; let successful `pi update` drain naturally instead.
			// https://github.com/nodejs/node/issues/56645
			return;
		}
		process.exit(exitCode);
		return;
	}

	if (await handleConfigCommand(args)) {
		return;
	}

	if (args[0] === "mcp") {
		const { runMcpCommand } = await loadMcpCommand();
		process.exitCode = await runMcpCommand(args.slice(1), { cwd, agentDir });
		return;
	}

	if (args[0] === "import") {
		const { runImportCommand } = await import("./durable/import.ts");
		process.exitCode = await runImportCommand(args.slice(1));
		return;
	}

	if (args[0] === "export") {
		const { runExportCommand } = await import("./durable/export.ts");
		process.exitCode = await runExportCommand(args.slice(1));
		return;
	}

	const parsed = parseArgs(args);
	if (parsed.diagnostics.length > 0) {
		for (const d of parsed.diagnostics) {
			const color = d.type === "error" ? chalk.red : chalk.yellow;
			console.error(color(`${d.type === "error" ? "Error" : "Warning"}: ${d.message}`));
		}
		if (parsed.diagnostics.some((d) => d.type === "error")) {
			process.exit(1);
		}
	}
	time("parseArgs");

	if (parsed.version) {
		console.log(VERSION);
		process.exit(0);
	}

	if (parsed.export) {
		let result: string;
		try {
			const outputPath = parsed.messages.length > 0 ? parsed.messages[0] : undefined;
			result = await exportFromFile(parsed.export, outputPath);
		} catch (error: unknown) {
			const message = error instanceof Error ? error.message : "Failed to export session";
			console.error(chalk.red(`Error: ${message}`));
			process.exit(1);
		}
		console.log(`Exported to: ${result}`);
		process.exit(0);
	}

	let appMode = resolveAppMode(parsed, process.stdin.isTTY, process.stdout.isTTY);
	const shouldTakeOverStdout = appMode !== "interactive" && !isPlainRuntimeMetadataCommand(parsed);
	if (shouldTakeOverStdout) {
		takeOverStdout();
	}

	if (parsed.mode === "rpc" && parsed.fileArgs.length > 0) {
		console.error(chalk.red("Error: @file arguments are not supported in RPC mode"));
		process.exit(1);
	}

	const sessionName = parsed.name === undefined ? undefined : normalizeSessionName(parsed.name);
	if (parsed.name !== undefined && sessionName === undefined) {
		console.error(chalk.red("Error: --name requires a non-empty value"));
		process.exit(1);
	}
	const nativeInteractive =
		appMode === "interactive" &&
		!parsed.help &&
		parsed.listModels === undefined;
	const plainMetadata = isPlainRuntimeMetadataCommand(parsed);
	if (parsed.unknownFlags.size > 0) {
		for (const option of parsed.unknownFlags.keys()) console.error(chalk.red(`Error: Unknown option --${option}. Use ${APP_COMMAND} --help.`));
		process.exit(1);
	}
	if (!nativeInteractive && (parsed.pythonUrl !== undefined || parsed.pythonToken !== undefined)) {
		console.error("python_target_requires_tty");
		process.exit(1);
	}
	if (plainMetadata && parsed.help) {
		printHelp();
		return;
	}
	if (plainMetadata && parsed.listModels !== undefined) {
		reportDiagnostics(collectSettingsDiagnostics(bootstrapSettingsManager));
		configureHttpDispatcher(bootstrapSettingsManager.getHttpIdleTimeoutMs());
		const modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15_000) });
		await listModels(modelRuntime, typeof parsed.listModels === "string" ? parsed.listModels : undefined, AbortSignal.timeout(15_000));
		return;
	}
	const startupBenchmark = isTruthyEnvFlag(process.env.AMAZME_STARTUP_BENCHMARK);
	if (startupBenchmark && !nativeInteractive) {
		console.error(chalk.red("Error: AMAZME_STARTUP_BENCHMARK only supports interactive mode"));
		process.exit(1);
	}
	if (parsed.noSession && (parsed.continue || parsed.resume)) {
		console.error(chalk.red("Error: --no-session cannot be combined with --continue or --resume"));
		process.exit(1);
	}
	if (parsed.session !== undefined && (parsed.continue || parsed.resume || parsed.noSession)) {
		console.error(chalk.red("Error: --session cannot be combined with --continue, --resume, or --no-session"));
		process.exit(1);
	}

	// An explicit session owns the project context: settings, trust, tools, and resources come from its recorded cwd.
	const sessionDirOption = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
	let explicitSession: { directory: string; cwd: string } | undefined;
	if (parsed.session !== undefined) {
		try {
			// Session lookup is the documented pre-trust use of the project's sessionDir setting.
			const lookupSessionDir = sessionDirOption ?? SettingsManager.create(cwd, agentDir).getSessionDir();
			explicitSession = await resolveExplicitSession(
				cwd,
				parsed.session,
				lookupSessionDir === undefined ? {} : { sessionDir: lookupSessionDir },
			);
		} catch (error) {
			console.error(chalk.red(`Error: ${error instanceof Error ? error.message : String(error)}`));
			process.exit(1);
		}
	}
	const effectiveCwd = explicitSession?.cwd ?? cwd;

	// Run migrations against the selected project so opening a session never migrates the launch directory.
	runMigrations(effectiveCwd);
	time("runMigrations");

	const startupSettingsManager = SettingsManager.create(effectiveCwd, agentDir);
	const startupSettingsDiagnostics = collectSettingsDiagnostics(startupSettingsManager);

	// Experimental first-time setup: theme choice and analytics opt-in.
	// Runs before any runtime services are created so the chosen settings apply everywhere.
	if (nativeInteractive && !startupBenchmark && shouldRunFirstTimeSetup()) {
		await showFirstTimeSetup(startupSettingsManager);
		time("firstTimeSetup");
	}

	if (appMode === "interactive" && parsed.useTheme !== undefined) {
		startupSettingsManager.applyOverrides({ theme: parsed.useTheme });
	}
	if (appMode === "interactive" && parsed.tuiMode !== undefined) {
		startupSettingsManager.applyOverrides({ tuiMode: parsed.tuiMode });
	}
	if (nativeInteractive && parsed.verbose) startupSettingsManager.applyOverrides({ quietStartup: false });

	if (nativeInteractive && process.env.AMAZME_DURABLE_TUI !== "1") {
		if ((parsed.pythonUrl === undefined) !== (parsed.pythonToken === undefined)) {
			console.error("python_target_required");
			process.exit(1);
		}
		const workspace = parsed.workspace || "primary";
		if (parsed.pythonUrl && parsed.pythonToken) {
			const { runPythonSessionTui } = await import("./python-session-tui.ts");
			await runPythonSessionTui({ url: parsed.pythonUrl, token: parsed.pythonToken, workspace });
		} else {
			const { runOwnedPythonInteractive } = await import("./python-session-tui.ts");
			await runOwnedPythonInteractive({ workspace, cwd: effectiveCwd });
		}
		printTimings();
		return;
	}

	if (nativeInteractive) {
		const { initialMessage, initialImages } = await prepareInitialMessage(parsed);
		const projectTrusted = await resolveProjectTrusted({
			cwd: effectiveCwd,
			trustStore: new ProjectTrustStore(agentDir),
			trustOverride: parsed.projectTrustOverride,
			defaultProjectTrust: bootstrapSettingsManager.getDefaultProjectTrust(),
			projectTrustContext: createProjectTrustContext({ cwd: effectiveCwd, mode: "interactive", settingsManager: startupSettingsManager, hasUI: true }),
		});
		startupSettingsManager.setProjectTrusted(projectTrusted);
		const sessionDir = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
		const { runDurableInteractive } = await import("./durable/interactive.ts");
		await runDurableInteractive({
			startupBenchmark,
			...(startupBenchmark ? {} : { startupNotice: startUpdateCheck() }),
			cwd: effectiveCwd,
			continueSession: parsed.continue === true || parsed.resume === true,
			noSession: parsed.noSession === true,
			...(explicitSession === undefined ? {} : { sessionDirectory: explicitSession.directory }),
			...(sessionDir === undefined ? {} : { sessionDir }),
			...(sessionName === undefined ? {} : { name: sessionName }),
			settingsManager: startupSettingsManager,
			...(parsed.extensions === undefined ? {} : { extensions: parsed.extensions }),
			noExtensions: parsed.noExtensions === true,
			...(parsed.systemPrompt === undefined ? {} : { systemPrompt: parsed.systemPrompt }),
			...(parsed.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: parsed.appendSystemPrompt }),
			...(parsed.skills === undefined ? {} : { skills: resolveCliPaths(cwd, parsed.skills) }),
			noSkills: parsed.noSkills === true,
			noContextFiles: parsed.noContextFiles === true,
			...(parsed.promptTemplates === undefined ? {} : { promptTemplates: resolveCliPaths(cwd, parsed.promptTemplates) }),
			noPromptTemplates: parsed.noPromptTemplates === true,
			...(parsed.themes === undefined ? {} : { themes: resolveCliPaths(cwd, parsed.themes) }),
			noThemes: parsed.noThemes === true,
			...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
			...(parsed.model === undefined ? {} : { model: parsed.model }),
			...(parsed.models === undefined ? {} : { models: parsed.models }),
			...(parsed.thinking === undefined ? {} : { thinkingLevel: parsed.thinking }),
			...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
			...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
			...(parsed.excludeTools === undefined ? {} : { excludeTools: parsed.excludeTools }),
			...(parsed.noTools ? { noTools: "all" as const } : parsed.noBuiltinTools ? { noTools: "builtin" as const } : {}),
			noMcp: parsed.noMcp === true || parsed.noExtensions === true,
			...(initialMessage === undefined ? {} : { initialMessage }),
			...(initialImages === undefined ? {} : { initialImages }),
			initialMessages: parsed.messages.slice(),
		});
		printTimings();
		return;
	}

	let stdinContent: string | undefined;
	let initialMessage: string | undefined;
	let initialImages: ImageContent[] | undefined;
	if (appMode !== "rpc") {
		stdinContent = await readPipedStdin();
		if (stdinContent !== undefined && appMode === "interactive") {
			appMode = "print";
		}
		time("readPipedStdin");
		const prepared = await prepareInitialMessage(parsed, stdinContent);
		initialMessage = prepared.initialMessage;
		initialImages = prepared.initialImages;
		time("prepareInitialMessage");
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: effectiveCwd,
		trustStore: new ProjectTrustStore(agentDir),
		trustOverride: parsed.projectTrustOverride,
		defaultProjectTrust: bootstrapSettingsManager.getDefaultProjectTrust(),
		projectTrustContext: createProjectTrustContext({ cwd: effectiveCwd, mode: appMode, settingsManager: startupSettingsManager, hasUI: false }),
	});
	startupSettingsManager.setProjectTrusted(projectTrusted);
	// --mode json/rpc and --print are not plain metadata, so --help still installs project packages
	// first. Stdout is already taken over, which keeps that chatter and the usage text off stdout.
	if (parsed.help || parsed.listModels !== undefined) {
		const { DefaultResourceLoader } = await import("./core/resource-loader.ts");
		await new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager: startupSettingsManager,
			noExtensions: true,
		}).reload();
		if (parsed.help) {
			printHelp();
			restoreStdout();
			return;
		}
		reportDiagnostics(startupSettingsDiagnostics);
		configureHttpDispatcher(startupSettingsManager.getHttpIdleTimeoutMs());
		const modelRuntime = await ModelRuntime.create({ signal: AbortSignal.timeout(15_000) });
		await listModels(modelRuntime, typeof parsed.listModels === "string" ? parsed.listModels : undefined, AbortSignal.timeout(15_000));
		restoreStdout();
		return;
	}
	const sessionDir = parsed.sessionDir ?? process.env[ENV_SESSION_DIR];
	const continuing = parsed.continue === true || parsed.resume === true;
	const durableOptions = {
		settingsManager: startupSettingsManager,
		cwd: effectiveCwd,
		continueSession: continuing,
		noSession: parsed.noSession === true,
		...(explicitSession === undefined ? {} : { sessionDirectory: explicitSession.directory }),
		...(sessionDir === undefined ? {} : { sessionDir }),
		...(sessionName === undefined ? {} : { name: sessionName }),
		...(parsed.extensions === undefined ? {} : { extensions: parsed.extensions }),
		noExtensions: parsed.noExtensions === true,
		...(parsed.systemPrompt === undefined ? {} : { systemPrompt: parsed.systemPrompt }),
		...(parsed.appendSystemPrompt === undefined ? {} : { appendSystemPrompt: parsed.appendSystemPrompt }),
		...(parsed.skills === undefined ? {} : { skills: resolveCliPaths(cwd, parsed.skills) }),
		noSkills: parsed.noSkills === true,
		noContextFiles: parsed.noContextFiles === true,
		...(parsed.promptTemplates === undefined ? {} : { promptTemplates: resolveCliPaths(cwd, parsed.promptTemplates) }),
		noPromptTemplates: parsed.noPromptTemplates === true,
		...(parsed.themes === undefined ? {} : { themes: resolveCliPaths(cwd, parsed.themes) }),
		noThemes: parsed.noThemes === true,
		...(parsed.provider === undefined ? {} : { provider: parsed.provider }),
		...(parsed.model === undefined ? {} : { model: parsed.model }),
		...(parsed.models === undefined ? {} : { models: parsed.models }),
		...(parsed.thinking === undefined ? {} : { thinkingLevel: parsed.thinking }),
		...(parsed.apiKey === undefined ? {} : { apiKey: parsed.apiKey }),
		...(parsed.tools === undefined ? {} : { tools: parsed.tools }),
		...(parsed.excludeTools === undefined ? {} : { excludeTools: parsed.excludeTools }),
		...(parsed.noTools ? { noTools: "all" as const } : parsed.noBuiltinTools ? { noTools: "builtin" as const } : {}),
		noMcp: parsed.noMcp === true || parsed.noExtensions === true,
	};
	if (process.env.AMAZME_DURABLE_TUI !== "1") {
		const prompt = [initialMessage, ...parsed.messages].filter((item): item is string => item !== undefined && item.length > 0).join("\n");
		const { runPythonHeadless } = await import("./python-headless.ts");
		const exitCode = await runPythonHeadless({
			mode: appMode === "rpc" ? "rpc" : appMode === "json" ? "json" : "text",
			workspace: parsed.workspace || "primary",
			cwd: effectiveCwd,
			...(parsed.pythonUrl === undefined ? {} : { url: parsed.pythonUrl }),
			...(parsed.pythonToken === undefined ? {} : { token: parsed.pythonToken }),
			prompt,
		});
		restoreStdout();
		if (exitCode !== 0) process.exitCode = exitCode;
		return;
	}
	if (appMode === "rpc") {
		const { runDurableRpc } = await import("./modes/rpc/durable-rpc.ts");
		await runDurableRpc(durableOptions);
		return;
	}
	// Text print only, and only when a person watches stderr; JSON and pipes stay clean.
	const updateNotice = appMode !== "json" && process.stderr.isTTY ? startUpdateCheck() : undefined;
	const { runDurablePrint } = await import("./durable/print.ts");
	const exitCode = await runDurablePrint({
		...durableOptions,
		mode: appMode === "json" ? "json" : "text",
		...(initialMessage === undefined ? {} : { initialMessage }),
		...(initialImages === undefined ? {} : { initialImages }),
		messages: parsed.messages.slice(),
	});
	restoreStdout();
	// The check normally finished during the run; never hold the exit for it longer than 1.5s.
	const message = updateNotice && (await Promise.race([updateNotice, delay(1500, undefined, { ref: false })]));
	if (message) process.stderr.write(`${message}\n`);
	if (exitCode !== 0) process.exitCode = exitCode;
}

async function startUpdateCheck(): Promise<string | undefined> {
	const { checkForUpdate, formatUpdateNotice } = await import("./update-check.ts");
	const notice = await checkForUpdate().catch(() => undefined);
	return notice === undefined ? undefined : formatUpdateNotice(notice);
}
