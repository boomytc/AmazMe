import { defineExtension } from "../harness/define.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export {
	type BashExecution,
	type BashPrepare,
	type BashToolInput,
	type BashToolOptions,
	createBashTool,
	createPowerShellTool,
	type PowerShellToolInput,
	type PowerShellToolOptions,
} from "./bash.ts";
export { createEditTool, type EditToolDetails, type EditToolInput } from "./edit.ts";
export { createReadTool, type ReadToolDetails, type ReadToolInput } from "./read.ts";
export { createWriteTool, type WriteToolInput } from "./write.ts";
export { createFindTool, type FindToolInput } from "./find.ts";
export { createGrepTool, type GrepToolInput } from "./grep.ts";
export { createLsTool, type LsToolInput } from "./ls.ts";
export type { SearchProgramOptions } from "./search-output.ts";
export { FileObservationDoc } from "./file-observations.ts";

/** `read`, `write`, `edit`, and `bash`; nothing installs it automatically. `createPowerShellTool()` adds `powershell`. */
export const CodingTools = defineExtension({
	name: "coding-tools",
	tools: [createReadTool(), createWriteTool(), createEditTool(), createBashTool()],
});

/** Read-only navigation tools; installation and selection belong to the host. */
export const FileSearchTools = defineExtension({
	name: "file-search-tools",
	tools: [createGrepTool(), createFindTool(), createLsTool()],
});
