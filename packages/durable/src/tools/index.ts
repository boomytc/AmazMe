import { defineExtension } from "../harness/define.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createFindTool } from "./find.ts";
import { createGrepTool } from "./grep.ts";
import { createLsTool } from "./ls.ts";
import { createReadTool, type ReadToolOptions } from "./read.ts";
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
export {
	createEditTool,
	type EditToolDetails,
	type EditToolInput,
} from "./edit.ts";
export {
	DEFAULT_IMAGE_LIMITS,
	type ImageLimits,
	type ImageProcessor,
	type PreparedImage,
} from "./image-processor.ts";
export {
	createReadTool,
	type ReadToolDetails,
	type ReadToolInput,
	type ReadToolOptions,
} from "./read.ts";
export {
	createWriteTool,
	type WriteToolInput,
	type WriteToolDetails,
} from "./write.ts";

/**
 * The `coding-tools` extension: `read`, `write`, `edit`, and `bash`; nothing installs it automatically.
 * `createPowerShellTool()` adds `powershell`. `images` prepares the images `read` returns (see `ReadToolOptions`).
 */
export function createCodingTools(options: ReadToolOptions = {}) {
	return defineExtension({
		name: "coding-tools",
		tools: [createReadTool(options), createWriteTool(), createEditTool(), createBashTool()],
	});
}

/** `createCodingTools()` without an image processor. */
export const CodingTools = createCodingTools();

export { createFindTool, type FindToolInput } from "./find.ts";
export { createGrepTool, type GrepToolInput } from "./grep.ts";
export { createLsTool, type LsToolInput } from "./ls.ts";
export type { SearchProgramOptions } from "./search-output.ts";
export { FileObservationDoc } from "./file-observations.ts";

/** Read-only navigation tools; installation and selection belong to the host. */
export const FileSearchTools = defineExtension({
	name: "file-search-tools",
	tools: [createGrepTool(), createFindTool(), createLsTool()],
});
