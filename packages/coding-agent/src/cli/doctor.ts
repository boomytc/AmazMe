import { collectDiagnostics } from "../core/local-diagnostics.ts";
import { formatDiagnosticReport } from "../core/diagnostics-types.ts";

export async function runDoctorCommand(
	args: string[],
	options: { cwd: string; agentDir: string },
): Promise<number> {
	if (args.includes("--help") || args.includes("-h")) {
		console.log(
			"Usage: amazme doctor [--json] [--zh]\nRead local configuration without creating files, running commands, or contacting providers.",
		);
		return 0;
	}
	if (args.some((arg) => arg !== "--json" && arg !== "--zh")) {
		console.error("Usage: amazme doctor [--json] [--zh]");
		return 2;
	}
	const report = await collectDiagnostics(options);
	console.log(
		args.includes("--json")
			? JSON.stringify(report, null, 2)
			: formatDiagnosticReport(report, args.includes("--zh") ? "zh" : "en"),
	);
	return report.entries.some((entry) => entry.level === "error") ? 1 : 0;
}
