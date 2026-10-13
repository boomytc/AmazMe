import { activationFacet, disposeResources } from "@amazme/protocol/services";
import { BACKGROUND_CONTEXT } from "@amazme/chord/context";
import { SlashCommands } from "../../core/plugins/slash-commands.ts";
import { SessionInsights } from "./insights.ts";
import { PresentationUI } from "./presentation-ui.ts";
import { SessionSettings, Settings } from "./settings.ts";

/** Optional commands for a hosted terminal; activation is gated by the service catalogue. */
export function createInsightsCommandsFacet() {
	return activationFacet(
		"@amazme/insights-commands",
		[SessionInsights, SlashCommands, PresentationUI, Settings, SessionSettings],
		async (services) => {
			const disposers: Array<() => void | Promise<void>> = [];
			try {
				const insights = services.get(SessionInsights),
					commands = services.get(SlashCommands),
					ui = services.get(PresentationUI);
				const settings = services.get(Settings),
					sessionSettings = services.get(SessionSettings);
				await (() => {
					disposers.push(
						commands.replace({
							name: "changes",
							description: "Review this turn's workspace changes",
							argumentHint: "[file]",
							async run(args, context) {
								await insights.refresh(context);
								const state = insights.state.value!;
								const file = state.files.find(
									(file) => file.path === args.trim() || `${file.root}/${file.path}` === args.trim(),
								);
								ui.showStatus(
									args.trim()
										? file
											? await insights.diff(state.conversationId, file.root, file.path, context)
											: "没有匹配的变更文件。"
										: [
												"本轮工作区变更（可能包含人工并发修改）：",
												...state.files.map((file) => `${file.root}/${file.path} +${file.added} -${file.removed}`),
												...state.notes,
												...state.verification.map(
													(item) => `${item.command}: ${item.exitCode === null ? "结果未知" : `退出码 ${item.exitCode}`}`,
												),
											].join("\n"),
									context,
								);
							},
						}),
					);
					disposers.push(
						commands.replace({
							name: "resume_run",
							description: "Continue a budget-paused turn",
							async run(_args, context) {
								await insights.resume(insights.state.value!.conversationId, context);
								ui.showStatus("已允许继续当前回合。", context);
							},
						}),
					);
					disposers.push(
						commands.replace({
							name: "limits",
							description: "Show or set turn budgets",
							argumentHint: "[calls seconds USD]",
							async run(args, context) {
								if (args.trim()) {
									const values = args.trim().split(/\s+/).map(Number);
									if (
										values.length !== 3 ||
										!values.every((value) => Number.isFinite(value) && value >= 0) ||
										!values.slice(0, 2).every(Number.isSafeInteger)
									)
										throw new Error("用法：/limits 工具次数 秒数 美元；0 表示不限。");
									for (const [index, id] of ["runCalls", "runSeconds", "runCost"].entries())
										await settings.set(id, String(values[index]), context);
								}
								await sessionSettings.reload(context);
								ui.showStatus(
									(sessionSettings.state.value?.descriptors
										.filter((item) => ["runCalls", "runSeconds", "runCost"].includes(item.id))
										.map(
											(item) =>
												`${item.id === "runCalls" ? "工具次数" : item.id === "runSeconds" ? "秒数" : "美元"}: ${item.value}`,
										)
										.join(" · ") ?? "") + "；0 表示不限。",
									context,
								);
							},
						}),
					);
					disposers.push(
						commands.replace({
							name: "execution",
							description: "Select Unix file-write isolation",
							argumentHint: "[full-access|workspace-write|read-only]",
							async run(args, context) {
								if (args.trim()) await settings.set("executionMode", args.trim(), context);
								await sessionSettings.reload(context);
								ui.showStatus(
									`执行模式：${sessionSettings.state.value?.descriptors.find((item) => item.id === "executionMode")?.value}；从下一次工具启动生效，不限制读取和网络。`,
									context,
								);
							},
						}),
					);
					let paused: string | null | undefined;
					disposers.push(
						insights.state.subscribe(() => {
							const next = insights.state.value?.paused;
							if (next && next !== paused)
								ui.showStatus("本轮预算已用完。/resume_run 追加预算继续，或停止当前任务。", BACKGROUND_CONTEXT);
							paused = next;
						}),
					);
				})();

				return () => disposeResources(disposers);
			} catch (error) {
				await disposeResources(disposers);
				throw error;
			}
		},
	);
}
