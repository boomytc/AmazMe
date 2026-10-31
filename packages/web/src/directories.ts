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
			onMenuAction?(listener: (action: "new-session" | "settings") => void): () => void;
		};
	}
}
