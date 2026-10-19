import { prepareComputerUse } from "../packages/coding-agent/plugins/computer-use/scripts/prepare-computer-use.mjs";

console.log(JSON.stringify(await prepareComputerUse(), null, 2));
