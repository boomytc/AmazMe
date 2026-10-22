import {
	cleanupArguments,
	cleanupComputerUse,
} from "../packages/coding-agent/plugins/computer-use/scripts/cleanup-computer-use.mjs";
import { computerUseBuildRoot } from "./computer-use-paths.mjs";

console.log(
	JSON.stringify(
		await cleanupComputerUse({
			...cleanupArguments(process.argv.slice(2)),
			workRoot: computerUseBuildRoot(),
		}),
		null,
		2,
	),
);
