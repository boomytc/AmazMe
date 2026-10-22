import { prepareComputerUse } from "../packages/coding-agent/plugins/computer-use/scripts/prepare-computer-use.mjs";
import { preparePatchedComputerUse } from "../packages/coding-agent/plugins/computer-use/scripts/prepare-patched-computer-use.mjs";
import { computerUseBuildRoot } from "./computer-use-paths.mjs";

const args = process.argv.slice(2);
if (
	args.length &&
	(args.length !== 2 || args[0] !== "--source" || process.platform !== "darwin")
)
	throw new Error("Usage: prepare-computer-use.mjs [--source /path/to/cua]");
console.log(
	JSON.stringify(
		process.platform === "darwin"
			? await preparePatchedComputerUse({
					source: args[1],
					workRoot: computerUseBuildRoot(),
				})
			: await prepareComputerUse(),
		null,
		2,
	),
);
