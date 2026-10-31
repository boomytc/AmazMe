import type { Identity } from "../generated/contracts.ts";
import type { Locale } from "../locale.ts";
import type { ClientConnection, PythonClient } from "../transport/client.ts";
import type { PanelsState } from "./panels-state.ts";
import type { PendingWrites } from "./pending/writes.ts";

export interface PageServices {
	readonly client: PythonClient;
	readonly panels: PanelsState;
	readonly locale: () => Locale;
	readonly changed: () => void;
	readonly error: (error: unknown) => void;
	readonly hostActive: (identity: Identity) => boolean;
	readonly connection: () => ClientConnection;
	readonly ledger: (connection: ClientConnection) => PendingWrites;
	readonly hostLedger: (identity: Identity) => PendingWrites;
}
