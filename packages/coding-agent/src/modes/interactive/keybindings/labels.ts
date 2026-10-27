import { useWindowsKeybindings } from "./keybindings.ts";

export interface KeyTextFormatOptions {
	capitalize?: boolean;
	platform?: NodeJS.Platform;
	env?: NodeJS.ProcessEnv;
}

function formatKeyPart(part: string, options: KeyTextFormatOptions): string {
	const platform = options.platform ?? process.platform;
	let displayPart = part;
	if (part.toLowerCase() === "alt" && platform === "darwin") displayPart = "option";
	if (part.toLowerCase() === "super") {
		displayPart = platform === "darwin" ? "cmd" : useWindowsKeybindings(platform, options.env) ? "win" : "super";
	}
	return options.capitalize ? displayPart.charAt(0).toUpperCase() + displayPart.slice(1) : displayPart;
}

export function formatKeyText(key: string, options: KeyTextFormatOptions = {}): string {
	return key
		.split("/")
		.map((keys) =>
			keys
				.split("+")
				.map((part) => formatKeyPart(part, options))
				.join("+"),
		)
		.join("/");
}
