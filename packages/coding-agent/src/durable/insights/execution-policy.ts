import { execFile } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { basename, dirname, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { Context } from "@amazme/chord";
import type { ExecutionEnv, ShellExecOptions } from "@amazme/durable/env";
import { ExecutionError, err, FileError } from "@amazme/durable/env";
import { NodeExecutionEnv } from "@amazme/durable/env/node";
import type { SettingsManager } from "../../core/settings-manager.ts";
import {
	assertUnsharedFile,
	assertUnsharedWorkspaces,
} from "./workspace-boundary.ts";

const run = promisify(execFile);
const WRITES = new Set([
	"writeFile",
	"writeFileChecked",
	"removeFileChecked",
	"appendFile",
	"truncateFile",
	"flushFile",
	"renameFile",
	"createDir",
	"remove",
	"createTempDir",
	"createTempFile",
]);
const inside = (path: string, root: string): boolean =>
	path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

async function targetPath(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch (error: unknown) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
			throw error;
		const parent = dirname(path);
		if (parent === path) throw error;
		return resolve(
			await targetPath(parent),
			path.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)),
		);
	}
}

function profile(roots: readonly string[]): string {
	return `(version 1) (allow default) (deny file-link) (deny file-write*) (allow file-write* (literal "/dev/null"))${roots.map((root) => ` (allow file-write* (subpath ${JSON.stringify(root)}))`).join("")}`;
}

function writeAllowed(
	path: string,
	roots: readonly string[],
	artifact: string,
): boolean {
	return roots.some((root) => inside(path, root)) || inside(path, artifact);
}

/** Shell descendants get a kernel write boundary; built-in filesystem capabilities get the same canonical roots. */
export function createPolicyEnv(
	cwd: string,
	artifactDirectory: string,
	settings: SettingsManager,
	workspaces: () => Promise<readonly string[]>,
): ExecutionEnv {
	const base = new NodeExecutionEnv({ cwd, artifactDirectory });
	let available: Promise<string> | undefined;
	const backend = (): Promise<string> =>
		(available ??= (async () => {
			if (process.platform === "darwin") {
				await access("/usr/bin/sandbox-exec");
				await run(
					"/usr/bin/sandbox-exec",
					["-p", profile([]), "/bin/sh", "-c", "exit 0"],
					{ timeout: 5000 },
				);
				return "/usr/bin/sandbox-exec";
			}
			if (process.platform === "linux") {
				await run(
					"bwrap",
					[
						"--ro-bind",
						"/",
						"/",
						"--dev",
						"/dev",
						"--unshare-pid",
						"--proc",
						"/proc",
						"--die-with-parent",
						"--",
						"/bin/sh",
						"-c",
						"exit 0",
					],
					{ timeout: 5000 },
				);
				return "bwrap";
			}
			throw new Error("此系统不支持文件写入隔离");
		})().catch((error) => {
			available = undefined;
			throw error;
		}));
	const policy = async () => {
		await settings.reload();
		const mode = settings.getExecutionMode();
		const roots =
			mode === "workspace-write"
				? await Promise.all((await workspaces()).map((root) => realpath(root)))
				: [];
		// Prefer the real path when the directory already exists; otherwise keep the resolved path for prefix checks.
		// Do not put a missing directory into sandboxes — hardlink scan and bwrap --bind need a real inode.
		let artifact: string;
		let sandboxes = roots;
		try {
			artifact = await realpath(artifactDirectory);
			if (!roots.some((root) => inside(artifact, root)))
				sandboxes = [...roots, artifact];
		} catch (error: unknown) {
			if (
				!(error instanceof Error && "code" in error && error.code === "ENOENT")
			)
				throw error;
			artifact = resolve(artifactDirectory);
		}
		return { mode, roots, artifact, sandboxes };
	};
	return new Proxy(base, {
		get(target, property) {
			if (property === "exec")
				return async (
					command: string | readonly string[],
					options: ShellExecOptions | undefined,
					context: Context,
				) => {
					try {
						const { mode, sandboxes } = await policy();
						const shellPath = settings.getShellPath();
						if (mode === "full-access")
							return base.exec(
								typeof command === "string" && shellPath
									? [shellPath, "-c", command]
									: command,
								options,
								context,
							);
						const runner = await backend();
						await assertUnsharedWorkspaces(sandboxes, context);
						const argv =
							typeof command === "string"
								? [shellPath ?? "/bin/bash", "-c", command]
								: [...command];
						const args =
							process.platform === "darwin"
								? [runner, "-p", profile(sandboxes), ...argv]
								: [
										runner,
										"--ro-bind",
										"/",
										"/",
										"--dev",
										"/dev",
										"--unshare-pid",
										"--proc",
										"/proc",
										"--die-with-parent",
										...sandboxes.flatMap((root) => ["--bind", root, root]),
										"--",
										...argv,
									];
						return base.exec(args, options, context);
					} catch (error) {
						return err(
							new ExecutionError(
								"spawn_error",
								`文件写入隔离不可用：${error instanceof Error ? error.message : String(error)}`,
							),
						);
					}
				};
			const member: unknown = Reflect.get(target, property);
			if (typeof member !== "function") return member;
			if (typeof property !== "string" || !WRITES.has(property))
				return member.bind(target);
			return async (...args: unknown[]) => {
				try {
					const { mode, roots, artifact } = await policy();
					if (mode !== "full-access") {
						await backend();
						const paths =
							property === "renameFile" ? args.slice(0, 2) : args.slice(0, 1);
						if (property.startsWith("createTemp"))
							return err(
								new FileError(
									"permission_denied",
									"限制模式不允许工具创建项目外临时文件",
								),
							);
						for (const path of paths) {
							if (typeof path !== "string")
								return err(new FileError("invalid", "文件路径无效"));
							const absolute = await base.absolutePath(
								path,
								args[args.length - 1] as Context,
							);
							if (!absolute.ok) return absolute;
							const canonical = await targetPath(absolute.value);
							const namespace = resolve(
								await targetPath(dirname(absolute.value)),
								basename(absolute.value),
							);
							if (
								![canonical, namespace].every((value) =>
									writeAllowed(value, roots, artifact),
								)
							) {
								return err(
									new FileError(
										"permission_denied",
										"此路径不允许写入；检查执行隔离模式和项目工作区。",
										path,
									),
								);
							}
							await assertUnsharedFile(canonical);
						}
					}
					return Reflect.apply(member, target, args);
				} catch (error) {
					return err(
						new FileError(
							"permission_denied",
							`文件写入隔离不可用：${error instanceof Error ? error.message : String(error)}`,
						),
					);
				}
			};
		},
	});
}
