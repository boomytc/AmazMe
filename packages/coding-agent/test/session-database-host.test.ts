import { rm } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { Client } from "@amazme/client";
import { createUnixTransportFactory } from "@amazme/client/unix";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listSessions, sessionStoragePath, type SessionCatalogMetadata } from "../src/host/session-catalog.ts";
import { sessionOpenErrorText } from "../src/host/session-database-error.ts";
import { type RunningServer, startServer } from "../src/host/server.ts";
import { SessionManagement } from "../src/host/services/sessions.ts";
import { createServerServiceBinding } from "./experimental-service-binding.ts";
import { configureExperimentalWorkerModel, createExperimentalSessions } from "./experimental-session-support.ts";
import { snapshotDirectory, writeBrokenSessionDatabase } from "./session-database-fixtures.ts";
import { createTempDir } from "./temp-dir.ts";

const servers = new Set<RunningServer>();
const clients = new Set<Client>();
let agentDir: string;
let sessionsRoot: string;
let sessions: SessionCatalogMetadata[];

beforeEach(async () => {
	// Unix socket paths have a short length limit, so the host's directories live under /tmp.
	agentDir = createTempDir("amazme-db-host-agent-", { baseDirectory: "/tmp" });
	await configureExperimentalWorkerModel(agentDir);
	vi.stubEnv("AMAZME_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("AMAZME_OFFLINE", "1");
	sessionsRoot = join(agentDir, "experimental", "sessions");
	sessions = await createExperimentalSessions(sessionsRoot, ["broken-1", "healthy-1"]);
});

afterEach(async () => {
	await Promise.all([...clients].map((client) => client.dispose()));
	clients.clear();
	await Promise.all([...servers].map((server) => server.close()));
	servers.clear();
	vi.unstubAllEnvs();
});

async function connect(runtime: RunningServer): Promise<Client> {
	const client = await Client.connect({
		serverId: runtime.serverId,
		transportFactory: createUnixTransportFactory({ path: runtime.socketPath }),
	});
	clients.add(client);
	return client;
}

async function attach(client: Client, sessionId: string): Promise<void> {
	const services = createServerServiceBinding(client, { services: [SessionManagement] });
	try {
		await services.ready(BACKGROUND_CONTEXT);
		await services.get(SessionManagement).attach(sessionId, BACKGROUND_CONTEXT);
	} finally {
		await services.dispose(BACKGROUND_CONTEXT);
	}
}

describe.skipIf(process.platform === "win32")("server host with a Session database that cannot be used", () => {
	test("sends the readable error to the client, creates nothing, and keeps serving", async () => {
		const broken = sessions[0]!;
		const path = await writeBrokenSessionDatabase(broken.path, "newer-schema");
		expect(sessionStoragePath(broken)).toBe(path);
		const directory = createTempDir("amazme-db-host-", { baseDirectory: "/tmp" });
		const runtime = await startServer({ provider: "anthropic", model: "claude-sonnet-4-5", directory });
		servers.add(runtime);
		// Server startup may rewrite catalog metadata (`meta.json`, `.projects.json`), so compare from here.
		const before = await snapshotDirectory(sessionsRoot);

		const client = await connect(runtime);
		const error = await attach(client, broken.id).then(
			() => undefined,
			(caught: unknown) => caught,
		);
		expect(error).toMatchObject({ code: "unavailable", reason: "session_database_newer_schema" });
		// The text the web page and the desktop window show after "attach failed:".
		const shown = sessionOpenErrorText(error);
		expect(shown?.split("\n")).toEqual([
			`Cannot open session database ${path}`,
			"Reason: it was written by a newer version of AmazMe (schema version 99; this version supports up to 2).",
			"What to do: Upgrade AmazMe to the latest version, then open this session again. AmazMe did not create a new session in its place.",
		]);

		// The worker exited without writing to the database or creating a Session in its place.
		expect(await snapshotDirectory(sessionsRoot)).toEqual(before);
		expect((await listSessions(sessionsRoot)).map((session) => session.id).sort()).toEqual(["broken-1", "healthy-1"]);

		// The server stays up: the same connection and a new one both open a healthy Session.
		await attach(client, sessions[1]!.id);
		await attach(await connect(runtime), sessions[1]!.id);
		// Asking again reports the same error instead of a stale or empty Session.
		await expect(attach(await connect(runtime), broken.id)).rejects.toMatchObject({
			reason: "session_database_newer_schema",
		});
		await rm(directory, { recursive: true, force: true });
	}, 120_000);
});
