import { prepareComputerUse } from "../packages/coding-agent/plugins/computer-use/scripts/prepare-computer-use.mjs";
import {
	preparationArguments,
	preparePatchedComputerUse,
} from "../packages/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs";
import {
	computerUseReleaseRoot,
	prepareComputerUseBuildRoot,
} from "./computer-use-paths.mjs";

const options = preparationArguments(process.argv.slice(2));
if (process.platform !== "darwin" && Object.keys(options).length)
	throw new Error("Source and patched runtime selection require macOS");
console.log(
	JSON.stringify(
		process.platform === "darwin"
			? await preparePatchedComputerUse({
					...options,
					workRoot: await prepareComputerUseBuildRoot(options.version),
					releaseRoot: computerUseReleaseRoot(),
				})
			: await prepareComputerUse(),
		null,
		2,
	),
);
