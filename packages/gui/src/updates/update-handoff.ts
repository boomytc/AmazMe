export interface UpdateHelperPort {
	onData(listener: (chunk: string) => void): () => void;
	onDeath(listener: () => void): () => void;
	isAlive(): boolean;
	sendInstall(): Promise<void>;
	cancel(): void;
}

/** User decisions have no helper timeout: confirmation finishes before the helper is started. */
export async function handoffUpdate(options: {
	confirm(): Promise<boolean>;
	start(): UpdateHelperPort;
	quit(): Promise<void>;
	resume(): Promise<void>;
	timeoutMs?: number;
}): Promise<void> {
	let port: UpdateHelperPort | undefined;
	let handedOff = false;
	let dead = false;
	let buffer = "";
	let ready = false;
	let armed = false;
	let pending: (() => void) | undefined;
	let stopData: (() => void) | undefined;
	let stopDeath: (() => void) | undefined;
	const assertAlive = (): void => { if (dead || !port?.isAlive()) throw new Error("install"); };
	const wait = (check: () => boolean): Promise<void> => new Promise((resolve, reject) => {
		const timer = setTimeout(() => { pending = undefined; reject(new Error("install")); }, options.timeoutMs ?? 180_000);
		pending = () => {
			try { assertAlive(); if (!check()) return; clearTimeout(timer); pending = undefined; resolve(); }
			catch { clearTimeout(timer); pending = undefined; reject(new Error("install")); }
		};
		pending();
	});
	try {
		if (!await options.confirm()) throw new Error("postponed");
		port = options.start();
		stopDeath = port.onDeath(() => { dead = true; pending?.(); });
		stopData = port.onData(chunk => {
			buffer += chunk;
			if (buffer.length > 64) { dead = true; pending?.(); return; }
			for (;;) {
				const newline = buffer.indexOf("\n");
				if (newline < 0) break;
				const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
				if (line === "ready" && !ready) ready = true;
				else if (line === "armed" && ready && !armed) armed = true;
				else dead = true;
			}
			pending?.();
		});
		await wait(() => ready);
		assertAlive();
		await port.sendInstall();
		await wait(() => armed);
		assertAlive();
		await options.quit();
		handedOff = true;
	} finally {
		if (!handedOff) { port?.cancel(); await options.resume(); stopData?.(); stopDeath?.(); }
		// On success listeners remain until app exit; a spawned process alone never authorizes quit.
	}
}
