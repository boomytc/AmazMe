const RAW_STDOUT_RETRY_DELAY_MS = 10;

let rawStdoutWriteTail: Promise<void> = Promise.resolve();

async function writeRawStdoutChunk(text: string): Promise<void> {
	while (true) {
		try {
			await new Promise<void>((resolve, reject) => {
				try {
					process.stdout.write(text, (error) => {
						if (error) reject(error);
						else resolve();
					});
				} catch (error) {
					reject(error instanceof Error ? error : new Error(String(error)));
				}
			});
			return;
		} catch (error) {
			const writeError = error instanceof Error ? error : new Error(String(error));
			const code = (writeError as Error & { code?: unknown }).code;
			if (code !== "ENOBUFS" && code !== "EAGAIN" && code !== "EWOULDBLOCK") {
				throw writeError;
			}
			await new Promise<void>((resolve) => setTimeout(resolve, RAW_STDOUT_RETRY_DELAY_MS));
		}
	}
}

export function writeRawStdout(text: string): void {
	if (text.length === 0) {
		return;
	}
	rawStdoutWriteTail = rawStdoutWriteTail.then(() => writeRawStdoutChunk(text));
	void rawStdoutWriteTail.catch(() => {
		process.exit(1);
	});
}
