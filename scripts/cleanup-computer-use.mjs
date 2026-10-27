import {
	cleanupArguments,
	cleanupComputerUse,
} from "../tools/native/computer-use/scripts/cleanup-computer-use.mjs";
import { PATCH_BUILDS } from "../tools/native/computer-use/src/runtime-pin.ts";
import {
	computerUseBuildRoot,
	computerUseReleaseRoot,
} from "./computer-use-paths.mjs";

console.log(
	JSON.stringify(
		await cleanupComputerUse({
			...cleanupArguments(process.argv.slice(2)),
			releaseRoot: computerUseReleaseRoot(),
			workRoots: PATCH_BUILDS.map(({ pin }) =>
				computerUseBuildRoot(pin.version),
			),
		}),
		null,
		2,
	),
);
