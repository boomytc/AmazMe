import type { ImagePart } from "../generated/contracts.ts";
import type { Locale } from "../locale.ts";
import { prepareImageFile } from "./images.ts";
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
	async attach(files: readonly File[], locale: Locale): Promise<Draft> {
		const draft = this.current;
		for (const file of files) {
			const prepared = await prepareImageFile(file, locale);
			draft.images = [
				...draft.images,
				{
					id: newId(),
					name: prepared.name,
					dataUrl: prepared.dataUrl,
					bytes: prepared.bytes,
					image: {
						media_type: prepared.mediaType,
						data_base64: prepared.base64,
					},
				},
			];
			draft.revision++;
		}
		return draft;
	}
}
