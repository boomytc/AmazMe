import type { Locale } from "./locale.ts";
import type { PanelField } from "./panels.ts";
import { translate, type MessageKey } from "./strings.ts";

export interface DirectoryListing {
	readonly path: string;
	readonly parent: string | null;
	readonly entries: readonly { readonly name: string; readonly path: string }[];
}

declare global {
	interface Window {
		amazmeDesktop?: {
			pickDirectories(): Promise<readonly string[]>;
			/** Desktop menu actions forwarded by the shell. */
			onMenuAction?(listener: (action: "new-session" | "settings") => void): void;
		};
	}
}

/** A draft folder selection. Only the host can turn it into project permissions. */
export function createDirectoryField(field: PanelField, locale: Locale, options: {
	readonly browse: (path?: string) => Promise<DirectoryListing>;
	readonly pick: () => Promise<readonly string[] | undefined>;
	readonly folderIcon: () => Node;
}) {
	const copy = (key: MessageKey) => translate(locale, key);
	const body = document.createElement("div"); body.className = "directory-field";
	const value = document.createElement("input"); value.type = "hidden";
	const list = document.createElement("div"); list.className = "directory-selections";
	const help = document.createElement("p"); help.className = "directory-help"; help.textContent = copy("project.folderHint");
	const add = document.createElement("button"); add.type = "button"; add.className = "directory-add";
	add.append(options.folderIcon(), document.createTextNode(copy("project.addFolder")));
	const browser = document.createElement("div"); browser.className = "directory-browser"; browser.hidden = true;
	const path = document.createElement("input"); path.className = "directory-path"; path.setAttribute("aria-label", copy("project.directory"));
	const go = document.createElement("button"); go.type = "button"; go.textContent = copy("project.go");
	const up = document.createElement("button"); up.type = "button"; up.textContent = copy("project.parentFolder");
	const choose = document.createElement("button"); choose.type = "button"; choose.className = "directory-choose"; choose.textContent = copy("project.chooseFolder");
	const contents = document.createElement("div"); contents.className = "directory-contents";
	const navigation = document.createElement("div"); navigation.className = "directory-navigation"; navigation.append(path, go);
	const footer = document.createElement("div"); footer.className = "directory-browser-foot"; footer.append(up, choose);
	const error = document.createElement("p"); error.className = "directory-error"; error.setAttribute("role", "status");
	browser.append(navigation, contents, footer);
	body.append(value, list, help, add, browser, error);
	let selected = JSON.parse(field.value) as string[];
	let listing: DirectoryListing | undefined;
	let request = 0;
	const render = (): void => {
		value.value = JSON.stringify(selected);
		list.replaceChildren();
		for (const [index, directory] of selected.entries()) {
			const row = document.createElement("div"); row.className = "directory-selection";
			const primary = document.createElement("button"); primary.type = "button"; primary.className = "directory-primary";
			primary.title = directory; primary.setAttribute("aria-label", `${copy("project.defaultFolder")}: ${directory}`);
			const text = document.createElement("span"); text.className = "directory-text";
			const name = document.createElement("span"); name.textContent = directory.split(/[\\/]/).filter(Boolean).at(-1) ?? directory;
			const detail = document.createElement("small"); detail.textContent = directory;
			text.append(name, detail); primary.append(options.folderIcon(), text);
			if (index === 0) { const badge = document.createElement("span"); badge.className = "directory-default"; badge.textContent = copy("project.default"); primary.append(badge); }
			primary.addEventListener("click", () => { selected = [directory, ...selected.filter(path => path !== directory)]; render(); list.querySelector("button")?.focus(); });
			const remove = document.createElement("button"); remove.type = "button"; remove.className = "directory-remove"; remove.textContent = "×";
			remove.setAttribute("aria-label", `${copy("project.removeFolder")}: ${directory}`);
			remove.addEventListener("click", () => { selected = selected.filter(path => path !== directory); render(); add.focus(); });
			row.append(primary, remove); list.append(row);
		}
		body.classList.toggle("empty", selected.length === 0);
		value.dispatchEvent(new Event("change", { bubbles: true }));
	};
	const append = (paths: readonly string[]): void => { selected = [...new Set([...selected, ...paths])]; render(); };
	const browse = async (directory?: string): Promise<void> => {
		const revision = ++request;
		error.textContent = ""; choose.disabled = true;
		try {
			const next = await options.browse(directory);
			if (revision !== request || !body.isConnected) return;
			listing = next; path.value = next.path; up.disabled = next.parent === null;
			contents.replaceChildren();
			for (const entry of next.entries) {
				const button = document.createElement("button"); button.type = "button"; button.className = "directory-entry";
				button.append(options.folderIcon(), document.createTextNode(entry.name));
				button.addEventListener("click", () => { void browse(entry.path); }); contents.append(button);
			}
			choose.disabled = false;
		} catch {
			if (revision === request && body.isConnected) error.textContent = copy("project.folderFailed");
		}
	};
	go.addEventListener("click", () => { void browse(path.value); });
	path.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); event.stopPropagation(); void browse(path.value); } });
	up.addEventListener("click", () => { if (listing?.parent) void browse(listing.parent); });
	choose.addEventListener("click", () => { if (listing) { append([listing.path]); browser.hidden = true; add.focus(); } });
	add.addEventListener("click", () => {
		add.disabled = true; error.textContent = "";
		void options.pick().then(async paths => {
			if (!body.isConnected) return;
			if (paths !== undefined) { append(paths); return; }
			browser.hidden = false;
			await browse(listing?.path ?? selected[0]);
			if (body.isConnected) path.focus();
		}).catch(() => { if (body.isConnected) error.textContent = copy("project.folderFailed"); })
			.finally(() => { add.disabled = false; if (body.isConnected && browser.hidden) add.focus(); });
	});
	render();
	return { body, value, focus: add };
}
