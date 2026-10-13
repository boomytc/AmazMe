import { remoteService } from "@amazme/protocol/services";
import { type Context } from "@amazme/chord";
import type { DiagnosticReport } from "../../core/diagnostics-types.ts";

/** On-demand local observations, without replicated state or background work. */
export interface Diagnostics {
	report(context: Context): Promise<DiagnosticReport>;
}

export const Diagnostics = remoteService<Diagnostics>("amazme.diagnostics", {"report":0}, []);
