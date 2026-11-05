import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { expandTildePath } from "./agent-paths.ts";

/** Shell state has its own location; choosing it never selects another business profile. */
export function desktopDataDirectory(env: NodeJS.ProcessEnv): string {
    const explicit = env.AMAZME_GUI_SMOKE === "1" ? env.AMAZME_GUI_SMOKE_DATA_DIR ?? env.AMAZME_GUI_USER_DATA_DIR : env.AMAZME_GUI_USER_DATA_DIR;
    if (explicit !== undefined) {
        if (!isAbsolute(explicit)) throw new Error("desktop user data directory must be absolute");
        mkdirSync(explicit, { recursive: true, mode: 0o700 });
        return explicit;
    }
    const root = env.AMAZME_HOME ? expandTildePath(env.AMAZME_HOME) : join(homedir(), ".amazme");
    const target = resolve(root, "desktop");
    mkdirSync(target, { recursive: true, mode: 0o700 });
    return target;
}
