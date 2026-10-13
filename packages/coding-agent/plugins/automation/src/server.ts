import { HostSessions } from "@amazme/coding-agent/plugin";
import { createSchedulesFacet } from "./runtime.ts";

export default createSchedulesFacet(services => {
 const sessions = services.get(HostSessions);
 return {
  agentDir: () => sessions.agentDir(), hostId: () => sessions.hostId(),
  run: (sessionId, request, accepted, context) => sessions.prompt(sessionId, request, accepted, context),
  cancel: (sessionId, request, context) => sessions.cancelPrompt(sessionId, request, context),
 };
}, [HostSessions]);
