import { readClipboardFilePaths, readClipboardText } from "./clipboard.ts";
import { readClipboardImage, type ClipboardImage } from "./clipboard-image.ts";

export type ClipboardContent =
	| { type: "files"; paths: string[] }
	| { type: "image"; image: ClipboardImage }
	| { type: "text"; text: string };

/** Files, then images, then text; a departed target stops the read at every async boundary. */
export async function readClipboardContent(isActive: () => boolean): Promise<ClipboardContent | null> {
	if (!isActive()) return null;
	const paths = await readClipboardFilePaths();
	if (!isActive()) return null;
	if (paths?.length) return { type: "files", paths };
	const image = await readClipboardImage();
	if (!isActive()) return null;
	if (image) return { type: "image", image };
	const text = await readClipboardText();
	return text && isActive() ? { type: "text", text } : null;
}
