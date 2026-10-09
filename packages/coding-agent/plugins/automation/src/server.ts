import { defineFacet } from "@amazme/chord";
import { HostSessions } from "@amazme/coding-agent/plugin";
import { createSchedulesFacet } from "./runtime.ts";

export default defineFacet({
	id: "@amazme/automation",
	setup(env) {
		const sessions = env.use(HostSessions);
		createSchedulesFacet({
			agentDir: () => sessions.agentDir(),
			hostId: () => sessions.hostId(),
			run: (sessionId, request, accepted, context) => sessions.prompt(sessionId, request, accepted, context),
			cancel: (sessionId, request, context) => sessions.cancelPrompt(sessionId, request, context),
		}).setup(env);
	},
});
