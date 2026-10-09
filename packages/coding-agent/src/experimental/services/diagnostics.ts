import { type Context, defineService } from "@amazme/chord";
import type { DiagnosticReport } from "../../core/diagnostics-types.ts";

/** On-demand local observations, without replicated state or background work. */
export interface Diagnostics {
	report(context: Context): Promise<DiagnosticReport>;
}

export const Diagnostics = defineService<Diagnostics>("amazme.diagnostics");
