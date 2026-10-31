import * as A from "../actions.ts";
import type {
	ModelCatalog,
	ScheduleInput,
	SchedulesView,
	ScheduleView,
	Session,
	SessionModel,
	WorkspaceGrantView,
} from "../generated/contracts.ts";
import * as P from "../panels.ts";
import { isRecord } from "../transport/api.ts";
import { modelReference } from "./model-reference.ts";
import { newId } from "./pending/writes.ts";
import type { PageServices } from "./services.ts";

interface AutomationServices extends PageServices {
	readonly context: () => {
		readonly sessions: readonly Session[];
		readonly workspaces: readonly WorkspaceGrantView[];
		readonly catalog?: ModelCatalog;
		readonly selection?: SessionModel;
	};
	readonly openSession: (id: string) => Promise<void>;
}

export function scheduleRecord(row: ScheduleView): P.ScheduleRecordLike {
	const target = row.target;
	return {
		id: row.schedule_id,
		generation: row.generation ?? 1,
		target:
			target.kind === "session"
				? { kind: "session", sessionId: target.session_id }
				: {
						kind: "new_session",
						workspace: target.workspace ?? "primary",
						title: target.title ?? "定时任务",
						projectId: target.project_id ?? "",
						model: target.model_selection
							? JSON.stringify([
									target.model_selection.provider,
									target.model_selection.model,
								])
							: "",
					},
		prompt: row.text,
		rule:
			row.rule.kind === "interval"
				? { kind: "interval", everyMinutes: row.rule.every_minutes }
				: row.rule.kind === "once"
					? { kind: "once", at: row.rule.at, timeZone: row.rule.time_zone }
					: {
							kind: "cron",
							expression: row.rule.expression,
							timeZone: row.rule.time_zone,
						},
		busy: row.busy ?? "queue",
		missed: row.missed ?? "latest",
		graceMinutes: row.grace_minutes ?? 10,
		timeoutSeconds: row.timeout_seconds ?? 600,
		enabled: row.enabled ?? true,
		createdAt: row.created_at,
		nextRunAt: row.next_run_at,
		pending: row.pending
			? {
					sessionId: row.pending.session_id,
					deadlineAt: row.pending.deadline_at,
					cancelReason: row.pending.cancel_reason ?? null,
					problem: row.pending.problem ?? null,
				}
			: null,
		history:
			row.history?.map((item) => ({
				sessionId: item.session_id ?? "",
				startedAt: item.started_at,
				finishedAt: item.finished_at,
				scheduledFor: item.scheduled_for ?? null,
				status: item.status,
				detail: item.detail ?? null,
			})) ?? [],
	};
}

export class Automation {
	schedules?: SchedulesView;
	schedulesGeneration = 0;
	private readonly services: AutomationServices;
	constructor(services: AutomationServices) {
		this.services = services;
	}
	async loadSchedules(): Promise<void> {
		const generation = ++this.schedulesGeneration,
			identity = this.services.client.identity;
		const state = await this.services.client.call("GET /api/v1/schedules", {
			identity,
		});
		if (
			generation === this.schedulesGeneration &&
			identity !== undefined &&
			this.services.hostActive(identity)
		)
			this.schedules = state;
	}
	private scheduleContext(id: string): P.ScheduleEditorContext {
		const { sessions, workspaces, catalog, selection } =
			this.services.context();
		const sessionId = this.services.client.connection?.sessionId,
			model = selection ?? catalog?.current;
		return {
			id,
			sessionId,
			workspace:
				sessions.find((item) => item.session_id === sessionId)?.workspace ??
				"primary",
			workspaces: workspaces.map((item) => ({
				value: item.name,
				label: `${item.name} · ${item.host_path}`,
			})),
			models:
				catalog?.models.map((item) => ({
					value: JSON.stringify([item.provider, item.model]),
					label: `${item.label} · ${item.provider}`,
				})) ?? [],
			model: model ? JSON.stringify([model.provider, model.model]) : "",
		};
	}
	async scheduleAction(action: P.PanelAction): Promise<boolean> {
		if (action.kind === "open" || action.kind === "modal-close") return false;
		const { id, data } = action,
			fields = action.kind === "modal-submit" ? action.fields : {};
		const row = this.schedules?.schedules.find(
				(item) => item.schedule_id === data,
			),
			modal = this.services.panels.modal;
		if (id === "schedule:open-session") {
			const sessionId =
				row?.pending?.session_id ||
				[...(row?.history ?? [])].reverse().find((item) => item.session_id)
					?.session_id;
			if (!sessionId) throw new Error("该任务还没有运行会话");
			await this.services.openSession(sessionId);
			return true;
		}
		if (
			![
				A.SCHEDULE_RELOAD_ACTION,
				A.SCHEDULE_ADD_ACTION,
				A.SCHEDULE_EDIT_ACTION,
				A.SCHEDULE_REMOVE_ACTION,
				A.SCHEDULE_HISTORY_ACTION,
				A.SCHEDULE_HISTORY_MODAL,
				A.SCHEDULE_ADD_MODAL,
				A.SCHEDULE_REMOVE_MODAL,
				A.SCHEDULE_RUN_ACTION,
				A.SCHEDULE_CANCEL_ACTION,
				A.SCHEDULE_ENABLED_ACTION,
			].includes(id)
		)
			return false;
		const identity = this.services.client.identity;
		if (!identity) throw new Error("请先连接后端");
		const ledger = this.services.hostLedger(identity);
		if (id === A.SCHEDULE_RELOAD_ACTION) {
			await this.loadSchedules();
			this.services.changed();
			return true;
		}
		if (id === A.SCHEDULE_ADD_ACTION) {
			const pending = ledger.read("schedule:create", "POST /api/v1/schedules");
			this.services.panels.modal = P.addScheduleModal(this.services.locale(), {
				...this.scheduleContext(pending?.body.schedule_id ?? newId()),
				...(pending?.body.target.kind === "session"
					? { sessionId: pending.body.target.session_id }
					: {}),
			});
			if (pending) {
				const body = pending.body,
					rule = body.rule,
					target = body.target;
				const values: Readonly<Record<string, string>> = {
					targetKind: target.kind,
					title:
						target.kind === "new_session" ? (target.title ?? "定时任务") : "",
					workspace:
						target.kind === "new_session"
							? (target.workspace ?? "primary")
							: "",
					model:
						target.kind === "new_session" && target.model_selection
							? JSON.stringify([
									target.model_selection.provider,
									target.model_selection.model,
								])
							: "",
					prompt: body.text,
					kind: rule.kind,
					everyMinutes:
						rule.kind === "interval" ? String(rule.every_minutes) : "15",
					at: rule.kind === "once" ? rule.at : "",
					expression: rule.kind === "cron" ? rule.expression : "",
					timeZone: rule.kind === "interval" ? "" : rule.time_zone,
					busy: body.busy ?? "queue",
					missed: body.missed ?? "latest",
					graceMinutes: String(body.grace_minutes ?? 10),
					timeoutSeconds: String(body.timeout_seconds ?? 600),
				};
				this.services.panels.modal = {
					...this.services.panels.modal,
					notice: {
						tone: "info",
						text: "上次创建尚待确认；本次提交沿用原编号和输入。",
					},
					fields: this.services.panels.modal.fields.map((field) => ({
						...field,
						value: values[field.id] ?? field.value,
						readOnly: true,
					})),
				};
			}
			this.services.changed();
			return true;
		}
		if (
			[
				A.SCHEDULE_EDIT_ACTION,
				A.SCHEDULE_REMOVE_ACTION,
				A.SCHEDULE_HISTORY_ACTION,
			].includes(id)
		) {
			if (!row) throw new Error("定时计划不存在");
			const record = scheduleRecord(row);
			this.services.panels.modal =
				id === A.SCHEDULE_EDIT_ACTION
					? P.editScheduleModal(
							this.services.locale(),
							record,
							this.scheduleContext(row.schedule_id),
						)
					: id === A.SCHEDULE_REMOVE_ACTION
						? P.removeScheduleModal(this.services.locale(), row.schedule_id)
						: P.scheduleHistoryModal(this.services.locale(), record);
			if (id === A.SCHEDULE_REMOVE_ACTION)
				this.services.panels.modal = {
					...this.services.panels.modal,
					data: JSON.stringify({
						id: row.schedule_id,
						generation: row.generation,
						request_id: row.pending?.request_id ?? "",
					}),
				};
			this.services.changed();
			return true;
		}
		if (id === A.SCHEDULE_HISTORY_MODAL) {
			this.services.panels.modal = undefined;
			this.services.changed();
			return true;
		}
		if (id === A.SCHEDULE_ADD_MODAL) {
			if (modal?.id !== id || modal.data !== data) return true;
			const target: unknown = JSON.parse(data ?? "null");
			if (
				!isRecord(target) ||
				typeof target.id !== "string" ||
				typeof target.sessionId !== "string"
			)
				throw new Error("定时计划归属损坏");
			const scheduleId = target.id;
			const kind = fields.kind;
			const rule: ScheduleInput["rule"] =
				kind === "interval"
					? { kind, every_minutes: Number(fields.everyMinutes) }
					: kind === "once"
						? { kind, at: fields.at ?? "", time_zone: fields.timeZone ?? "" }
						: {
								kind: "cron",
								expression: fields.expression ?? "",
								time_zone: fields.timeZone ?? "",
							};
			if (
				(fields.busy !== "queue" && fields.busy !== "skip") ||
				(fields.missed !== "latest" && fields.missed !== "skip")
			)
				throw new Error("请选择运行策略");
			if (
				fields.targetKind !== "session" &&
				fields.targetKind !== "new_session"
			)
				throw new Error("请选择运行位置");
			const body: ScheduleInput = {
				schedule_id: scheduleId,
				target:
					fields.targetKind === "session"
						? { kind: "session", session_id: target.sessionId }
						: {
								kind: "new_session",
								workspace: fields.workspace ?? "primary",
								title: fields.title?.trim() || "定时任务",
								project_id:
									typeof target.projectId === "string" ? target.projectId : "",
								model_selection: fields.model
									? modelReference(fields.model)
									: null,
							},
				text: fields.prompt ?? "",
				rule,
				busy: fields.busy,
				missed: fields.missed,
				grace_minutes: Number(fields.graceMinutes),
				timeout_seconds: Number(fields.timeoutSeconds),
				expected_generation:
					typeof target.expectedGeneration === "number"
						? target.expectedGeneration
						: 0,
			};
			const key = body.expected_generation
				? `schedule:save:${scheduleId}`
				: "schedule:create";
			await ledger.send(
				key,
				ledger.prepare(key, "POST /api/v1/schedules", () => ({
					path: {},
					body,
				})),
				this.services.client,
				identity,
			);
		} else if (id === A.SCHEDULE_REMOVE_MODAL) {
			if (modal?.id !== id || modal.data !== data) return true;
			const target: unknown = JSON.parse(data ?? "null");
			if (
				!isRecord(target) ||
				typeof target.id !== "string" ||
				typeof target.generation !== "number" ||
				typeof target.request_id !== "string"
			)
				throw new Error("定时计划归属损坏");
			await this.services.client.call(
				"POST /api/v1/schedules/{schedule_id}/remove",
				{
					path: { schedule_id: target.id },
					body: {
						expected_generation: target.generation,
						request_id: target.request_id,
					},
				},
			);
		} else if (
			[
				A.SCHEDULE_RUN_ACTION,
				A.SCHEDULE_CANCEL_ACTION,
				A.SCHEDULE_ENABLED_ACTION,
			].includes(id)
		) {
			if (!row) throw new Error("定时计划不存在");
			if (id === A.SCHEDULE_RUN_ACTION) {
				const key = `schedule:run:${row.schedule_id}`;
				await ledger.send(
					key,
					ledger.prepare(
						key,
						"POST /api/v1/schedules/{schedule_id}/run",
						(operationId) => ({
							path: { schedule_id: row.schedule_id },
							body: {
								operation_id: operationId,
								expected_generation: row.generation ?? 1,
							},
						}),
					),
					this.services.client,
					identity,
				);
			} else if (id === A.SCHEDULE_CANCEL_ACTION)
				await this.services.client.call(
					"POST /api/v1/schedules/{schedule_id}/cancel",
					{
						path: { schedule_id: row.schedule_id },
						body: {
							expected_generation: row.generation ?? 1,
							request_id: row.pending?.request_id ?? "",
						},
					},
				);
			else
				await this.services.client.call(
					"POST /api/v1/schedules/{schedule_id}/enabled",
					{
						path: { schedule_id: row.schedule_id },
						body: {
							expected_generation: row.generation ?? 1,
							enabled: action.kind === "control" && action.value === "true",
						},
					},
				);
		} else return false;
		await this.loadSchedules();
		if (this.services.panels.modal === modal)
			this.services.panels.modal = undefined;
		this.services.changed();
		return true;
	}
}
