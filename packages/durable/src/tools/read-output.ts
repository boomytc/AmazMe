import { Type } from "typebox";
import type { Static } from "typebox";

/** Text, or an inline image with the note used by both application runtimes. */
export const readOutputSchema = Type.Union([
	Type.String(),
	Type.Object({
		type: Type.Literal("image"),
		data: Type.String(),
		mimeType: Type.String(),
		note: Type.String(),
	}),
]);
export type ReadToolOutput = Static<typeof readOutputSchema>;
