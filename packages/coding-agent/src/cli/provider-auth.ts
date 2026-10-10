import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import type { AuthEvent, AuthPrompt, AuthType } from "@amazme/ai";
import { CredentialSynchronizationError, ModelRuntime } from "../core/model-runtime.ts";
import { SettingsManager } from "../core/settings-manager.ts";
import { openBrowser } from "../utils/open-browser.ts";
import { AuthCommandError } from "./auth-command.ts";

/** A terminal adapter for the existing provider login API; credentials stay in its shared store. */
export async function runProviderAuthCommand(
	kind: "login" | "logout",
	providerId: string,
	requestedType?: AuthType,
): Promise<void> {
	const controller = new AbortController();
	const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(300_000)]);
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	let readline: ReturnType<typeof createInterface> | undefined;
	let settings: SettingsManager | undefined;
	let muted = false;
	try {
		const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
		const provider = runtime.getProvider(providerId);
		if (!provider) throw new AuthCommandError(`Unknown provider: ${providerId}`);
		if (kind === "logout") {
			await runtime.logout(providerId, { signal });
			process.stdout.write(`Removed saved credentials for ${provider.name}. Environment credentials remain available.\n`);
			return;
		}

		const methods: { id: AuthType; label: string }[] = [];
		if (provider.auth.oauth) methods.push({ id: "oauth", label: provider.auth.oauth.name });
		if (provider.auth.apiKey?.login) methods.push({ id: "api_key", label: provider.auth.apiKey.name });
		if (methods.length === 0) throw new AuthCommandError(`${provider.name} uses ambient credentials; see providers.md`);
		if (requestedType && !methods.some((method) => method.id === requestedType))
			throw new AuthCommandError(`${provider.name} does not support the requested login method`);
		if (!process.stdin.isTTY || !process.stderr.isTTY)
			throw new AuthCommandError("Run auth login in an interactive terminal");

		const output = new Writable({
			write(chunk: Uint8Array | string, _encoding, callback) {
				if (muted) callback();
				else process.stderr.write(chunk, callback);
			},
		});
		readline = createInterface({ input: process.stdin, output, terminal: true, historySize: 0 });
		readline.on("SIGINT", cancel);
		readline.on("close", cancel);
		const prompt = async (step: AuthPrompt): Promise<string> => {
			const promptSignal = step.signal ? AbortSignal.any([signal, step.signal]) : signal;
			promptSignal.throwIfAborted();
			const label = `${step.message}${"placeholder" in step && step.placeholder ? ` (${step.placeholder})` : ""}`;
			if (step.type === "select") {
				process.stderr.write(`${label}\n`);
				for (const [index, option] of step.options.entries())
					process.stderr.write(`  ${index + 1}. ${option.label}${option.description ? ` — ${option.description}` : ""}\n`);
				while (true) {
					const value = (await readline!.question("Choose a number: ", { signal: promptSignal })).trim();
					const option = /^\d+$/.test(value) ? step.options[Number(value) - 1] : undefined;
					if (option) return option.id;
					process.stderr.write("Choose one of the listed numbers.\n");
				}
			}
			if (step.type !== "secret") return readline!.question(`${label}: `, { signal: promptSignal });
			process.stderr.write(`${label}: `);
			muted = true;
			try {
				const value = await readline!.question("", { signal: promptSignal });
				if (!value.trim()) throw new AuthCommandError("A credential is required; nothing was saved");
				return value;
			} finally {
				muted = false;
				process.stderr.write("\n");
			}
		};
		const type = requestedType ?? (methods.length === 1 ? methods[0].id : await prompt({
			type: "select", message: `Sign in to ${provider.name}`, options: methods,
		}));
		if (type !== "oauth" && type !== "api_key") throw new AuthCommandError("Invalid login method");
		settings = SettingsManager.create(process.cwd());
		await runtime.login(providerId, type, { signal, prompt, notify }, {
			getDeviceId: () => settings!.getOrCreateDeviceId(),
		});
		process.stdout.write(`Signed in to ${provider.name}.\n`);
	} catch (error) {
		if (error instanceof CredentialSynchronizationError)
			throw new AuthCommandError(`Saved credential ${kind} for ${providerId}, but local model state could not be synchronized. Run auth check.`);
		if (signal.aborted) throw new AuthCommandError("Authentication cancelled or timed out");
		if (error instanceof AuthCommandError) throw error;
		throw new AuthCommandError(`Provider ${kind} failed. Retry or run auth check --provider ${providerId}.`);
	} finally {
		readline?.removeListener("close", cancel);
		readline?.close();
		process.removeListener("SIGINT", cancel);
		process.removeListener("SIGTERM", cancel);
		await settings?.flush();
	}
}

function notify(event: AuthEvent): void {
	if (event.type === "auth_url") {
		process.stderr.write(`${event.url}\n${event.instructions ?? "Complete sign-in in your browser."}\n`);
		openBrowser(event.url);
	} else if (event.type === "device_code") {
		process.stderr.write(`${event.verificationUri}\nEnter code: ${event.userCode}\n`);
		openBrowser(event.verificationUri);
	} else {
		process.stderr.write(`${event.message}\n`);
		if (event.type === "info")
			for (const link of event.links ?? []) process.stderr.write(`${link.label ? `${link.label}: ` : ""}${link.url}\n`);
	}
}
