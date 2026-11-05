import { existsSync, lstatSync, mkdirSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandTildePath } from "./agent-paths.ts";

/** Shell state has its own location; choosing it never selects another business profile. */
export function desktopDataDirectory(legacy: string, env: NodeJS.ProcessEnv): string {
    const explicit = env.AMAZME_GUI_SMOKE === "1" ? env.AMAZME_GUI_SMOKE_DATA_DIR ?? env.AMAZME_GUI_USER_DATA_DIR : env.AMAZME_GUI_USER_DATA_DIR;
    if (explicit !== undefined) {
        if (!isAbsolute(explicit)) throw new Error("desktop user data directory must be absolute");
        mkdirSync(explicit, { recursive: true, mode: 0o700 });
        return explicit;
    }
    const root = env.AMAZME_HOME ? expandTildePath(env.AMAZME_HOME) : join(homedir(), ".amazme");
    const target = resolve(root, "desktop");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const marker = join(target, "legacy-shell-import.json");
    if (legacy === target || env.AMAZME_HOME || existsSync(marker)) return target;
    const updates = join(legacy, "updates");
    if (existsSync(updates) && readdirSync(updates).length > 0) {
        if (lstatSync(join(legacy, "SingletonLock"), { throwIfNoEntry: false }) !== undefined || existsSync(join(updates, "python-update.json"))) {
            throw new Error("desktop legacy update must finish before moving shell data");
        }
        const destination = join(target, "updates");
        if (existsSync(destination)) throw new Error("desktop update state exists in both data directories");
        renameSync(updates, destination);
    }
    writeFileSync(marker, JSON.stringify({ source: legacy }), { mode: 0o600 });
    return target;
}
