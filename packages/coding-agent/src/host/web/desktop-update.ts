import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

export const DESKTOP_UPDATE_TOKEN_ENV = "AMAZME_DESKTOP_UPDATE_TOKEN";
export function takeDesktopUpdateToken(env: NodeJS.ProcessEnv): string | undefined {
	const value = env[DESKTOP_UPDATE_TOKEN_ENV]; delete env[DESKTOP_UPDATE_TOKEN_ENV];
	return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
}
/** A private capability sent over the parent/child environment, never exposed in the served page. */
export function authorizedDesktopUpdate(request: Pick<IncomingMessage, "method" | "headers">, token: string | undefined): boolean {
	const supplied = request.headers["x-amazme-desktop-update"];
	return token !== undefined && request.method === "POST" && request.headers.origin === undefined && typeof supplied === "string"
		&& /^[a-f0-9]{64}$/.test(supplied) && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
}
