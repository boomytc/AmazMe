export interface DirectoryListing {
	readonly path: string;
	readonly parent: string | null;
	readonly entries: readonly { readonly name: string; readonly path: string }[];
}
