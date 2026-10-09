import { defineFacet } from "@amazme/chord";
import { HostSessions } from "@amazme/coding-agent/plugin";
import { createSchedulesFacet } from "./runtime.ts";

export default defineFacet({
	id: "@amazme/automation",
	setup(env) {
		const sessions = env.use(HostSessions);
		createSchedulesFacet({
			agentDir: () => sessions.agentDir(),
			run: (sessionId, prompt, context) => sessions.prompt(sessionId, prompt, context),
		}).setup(env);
	},
});
