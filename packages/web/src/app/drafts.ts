import type { ImagePart } from "../generated/contracts.ts";
import { attachmentRejection } from "../view.ts";
import { newId } from "./pending/writes.ts";

interface ImageDraft {
	readonly id: string;
	readonly name: string;
	readonly dataUrl: string;
	readonly bytes: number;
	readonly image: ImagePart;
}
export interface Draft {
	text: string;
	images: ImageDraft[];
	revision: number;
	submission?: { readonly id: string; readonly revision: number };
}

/** Unsent input belongs to a window and session; a submission retains its original draft revision. */
export class DraftBook {
	current: Draft = { text: "", images: [], revision: 0 };
	private readonly sessions = new Map<string, Draft>();
	private sessionId?: string;
	delete(sessionId: string): void {
		this.sessions.delete(sessionId);
		if (this.sessionId === sessionId) this.sessionId = undefined;
	}
	select(target: string): void {
		if (this.sessionId) this.sessions.set(this.sessionId, this.current);
		this.sessionId = target;
		this.current = this.sessions.get(target) ?? {
			text: "",
			images: [],
			revision: 0,
		};
	}
	clear(draft: Draft, revision: number): boolean {
		if (draft.revision !== revision) return false;
		draft.text = "";
		draft.images = [];
		draft.revision++;
		return this.current === draft;
	}
	async attach(files: readonly File[]): Promise<Draft> {
		const draft = this.current;
		for (const file of files) {
			const rejection = attachmentRejection({
				mediaType: file.type,
				bytes: file.size,
			});
			if (rejection)
				throw new Error(
					rejection === "composer.attachmentTooLarge"
						? "图片不能超过 8 MiB"
						: "不支持的图片格式",
				);
			const mediaType = file.type;
			if (
				mediaType !== "image/png" &&
				mediaType !== "image/jpeg" &&
				mediaType !== "image/webp" &&
				mediaType !== "image/gif"
			)
				continue;
			const dataUrl = await new Promise<string>((resolve, reject) => {
				const reader = new FileReader();
				reader.onload = () =>
					typeof reader.result === "string"
						? resolve(reader.result)
						: reject(new Error("图片读取失败"));
				reader.onerror = () => reject(reader.error);
				reader.readAsDataURL(file);
			});
			draft.images = [
				...draft.images,
				{
					id: newId(),
					name: file.name,
					dataUrl,
					bytes: file.size,
					image: {
						media_type: mediaType,
						data_base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
					},
				},
			];
			draft.revision++;
		}
		return draft;
	}
}
