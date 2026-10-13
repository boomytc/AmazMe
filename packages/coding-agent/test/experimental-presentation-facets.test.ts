import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { readPluginBuild } from "../src/core/plugins/artifact.ts";
import { afterEach, describe, expect, test } from "vitest";
import {
	activateBuiltinClientServices,
	type ClientRuntime,
	openClientRuntime,
} from "../src/host/client-runtime.ts";
import { createPresentationFacetData, createPresentationFacetLoaders } from "../src/host/plugins/bundled.ts";
import { createServerPluginPackage, restoreServerPluginPackageProfile } from "../src/host/plugins/package.ts";
import { type RunningServer, startServer } from "../src/host/server.ts";
import { PresentationPlugins } from "../src/host/services/plugins.ts";

const runtimes = new Set<ClientRuntime>();
const runningServers = new Set<RunningServer>();
const directories = new Set<string>();

afterEach(async () => {
	await Promise.allSettled([...runtimes].map((runtime) => runtime.dispose()));
	await Promise.allSettled([...runningServers].map((server) => server.close()));
	await Promise.allSettled([...directories].map((directory) => rm(directory, { force: true, recursive: true })));
	runtimes.clear();
	runningServers.clear();
	directories.clear();
});

describe("server-selected presentation facets", () => {
	test("rejects local plugin paths for Radius servers", async () => {
		await expect(
			openClientRuntime({
				command: "client",
				connect: { transport: "radius", serverId: randomUUID() },
				pluginPackages: ["./local-plugin"],
			}),
		).rejects.toThrow("only be configured on a local Unix server");
	});

	test("restores plugin package selections for later server generations", async () => {
		const directory = await mkdtemp("/tmp/pi-presentation-profile-");
		directories.add(directory);
		const serverId = randomUUID();
		const packagePaths = [join(directory, "first-plugin"), join(directory, "second-plugin")];
		await expect(restoreServerPluginPackageProfile(directory, serverId, packagePaths)).resolves.toEqual(packagePaths);
		await expect(restoreServerPluginPackageProfile(directory, serverId)).resolves.toEqual(packagePaths);
		await expect(restoreServerPluginPackageProfile(directory, serverId, [])).resolves.toEqual([]);
		await expect(restoreServerPluginPackageProfile(directory, serverId)).resolves.toEqual([]);
	});

	test("builds conventional plugin entries into the server-owned plugin cache", async () => {
		const directory = await mkdtemp("/tmp/pi-presentation-package-");
		directories.add(directory);
		const serverId = randomUUID();
		const packagePath = join(directory, "amazme-example-plugin");
		await mkdir(join(packagePath, "src"), { recursive: true });
		await writeFile(
			join(packagePath, "package.json"),
			`${JSON.stringify({
				name: "@amazme/test-plugin",
				version: "1.0.0",
				peerDependencies: {
					"@amazme/chord": "^0.84.4",
					"@amazme/coding-agent": "^0.84.4",
				},
			})}\n`,
		);
		const sourcePath = join(packagePath, "src", "tui.ts");
		await writeFile(
			sourcePath,
			'import { defineFacet } from "@amazme/chord"; import { SlashCommands } from "@amazme/coding-agent/host/plugin"; export default defineFacet(() => { void "built-a"; }, { uses: [SlashCommands.contract] });\n',
		);
		const plugin = createServerPluginPackage(directory, serverId, packagePath);

		const first = await plugin.build();
		expect(first).toHaveLength(1);
		expect(plugin.manifestPath).toMatch(
			new RegExp(`/plugin-builds/${serverId}/amazme-example-plugin-[a-f0-9]{12}/plugin\\.json$`, "u"),
		);
		expect(first[0]?.name).toBe("@amazme/test-plugin/tui");
		const firstLoaded = await createPresentationFacetLoaders(createPresentationFacetData(first))[0]!([]);
		expect(firstLoaded.map(({ name }) => name)).toEqual(["@amazme/test-plugin/tui"]);

		await writeFile(
			sourcePath,
			'import { defineFacet } from "@amazme/chord"; import { SlashCommands } from "@amazme/coding-agent/host/plugin"; export default defineFacet(() => { void "built-b"; }, { uses: [SlashCommands.contract] });\n',
		);
		const second = await plugin.build();
		expect(second[0]?.code).not.toBe(first[0]?.code);
		const secondLoaded = await createPresentationFacetLoaders(createPresentationFacetData(second))[0]!([]);
		expect(secondLoaded.map(({ name }) => name)).toEqual(["@amazme/test-plugin/tui"]);

		const secondPackagePath = join(directory, "second-plugin");
		await mkdir(join(secondPackagePath, "src"), { recursive: true });
		await Promise.all([
			writeFile(
				join(secondPackagePath, "package.json"),
				`${JSON.stringify({
					name: "@amazme/second-test-plugin",
					version: "1.0.0",
					peerDependencies: { "@amazme/chord": "^0.84.4" },
				})}\n`,
			),
			writeFile(
				join(secondPackagePath, "src", "tui.ts"),
				'import { defineFacet } from "@amazme/chord"; export default defineFacet(() => {});\n',
			),
		]);
		const running = await startServer({
			directory: join(directory, "server"),
			sessionDir: join(directory, "sessions"),
		});
		runningServers.add(running);
		const runtime = await openClientRuntime({
			command: "client",
			connect: { transport: "unix", path: running.socketPath },
			pluginPackages: [packagePath, secondPackagePath],
		});
		runtimes.add(runtime);
		const activated = await activateBuiltinClientServices(runtime.servers[0]!);
		const sessionId = randomUUID();
		await activated.management.create({ id: sessionId }, BACKGROUND_CONTEXT);
		const presentationPlugins = await activated.plugins.prepareSession(
			{ sessionId, packagePaths: [packagePath, secondPackagePath] },
			BACKGROUND_CONTEXT,
		);
		await expect(restoreServerPluginPackageProfile(join(directory, "server"), running.serverId)).resolves.toEqual([]);
		const serverLoaded = await Promise.all(
			createPresentationFacetLoaders(presentationPlugins).map((loader) => loader([])),
		);
		expect(serverLoaded.flatMap(facets => facets.map(({ name }) => name))).toEqual(["@amazme/test-plugin/tui", "@amazme/second-test-plugin/tui"]);

		await writeFile(
			sourcePath,
			'import { defineFacet } from "@amazme/chord"; import { SlashCommands } from "@amazme/coding-agent/host/plugin"; export default defineFacet(() => { void "built-c"; }, { uses: [SlashCommands.contract] });\n',
		);
		const services = runtime.servers[0]!.server.open({
			services: [PresentationPlugins],
			assertAccess() {},
			onError() {},
		});
		try {
			await services.ready(BACKGROUND_CONTEXT);
			const data = await services.get(PresentationPlugins).reload(BACKGROUND_CONTEXT);
			const reloaded = await Promise.all(createPresentationFacetLoaders(data).map((loader) => loader([])));
			expect(reloaded.flatMap(facets => facets.map(({ name }) => name))).toEqual(["@amazme/test-plugin/tui", "@amazme/second-test-plugin/tui"]);
		} finally {
			await services.dispose(BACKGROUND_CONTEXT);
		}
	});

	test("builds the example plugin package without a package-owned build script", async () => {
		const directory = await mkdtemp("/tmp/amazme-example-plugin-");
		directories.add(directory);
		const serverId = randomUUID();
		const packagePath = fileURLToPath(new URL("../examples/plugins/amazme-example-plugin", import.meta.url));
		const plugin = createServerPluginPackage(directory, serverId, packagePath);

		const artifacts = await plugin.build();
		const manifest = await readPluginBuild(plugin.manifestPath);
		expect(manifest.name).toBe("@amazme/example-plugin");
		expect(Object.keys(manifest.entries)).toEqual(["session", "tui"]);
		const loaded = await createPresentationFacetLoaders(createPresentationFacetData(artifacts))[0]!([]);
		expect(loaded.map(({ name }) => name)).toEqual(["@amazme/example-plugin/tui"]);
	});
});
