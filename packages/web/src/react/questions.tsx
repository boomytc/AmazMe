import type { FormEvent } from "react";
import { useMemo, useState } from "react";
import { QUESTION_ANSWER_ACTION } from "../actions.ts";
import type {
	QuestionAnswer,
	QuestionView,
	UserAnswer,
} from "../generated/contracts.ts";
import type { Locale } from "../locale.ts";
import type { PageRenderer } from "../render.ts";

type Answer = Pick<QuestionAnswer, "kind" | "answers">;
type DraftAnswer = {
	readonly selected: readonly string[];
	readonly custom: string;
};

interface QuestionFormProps {
	readonly question: QuestionView;
	readonly locale: Locale;
	readonly sessionId: string;
	readonly readOnly: boolean;
	readonly actions: PageRenderer;
}

function initialDrafts(
	question: QuestionView,
): Readonly<Record<string, DraftAnswer>> {
	return Object.fromEntries(
		question.questions.map((item) => {
			const recommended = (item.options ?? []).filter(
				(option) =>
					option.recommended === true ||
					/\((?:Recommended|推荐)\)$/iu.test(option.label),
			);
			return [
				item.id,
				{
					selected: item.multi_select
						? recommended.map((option) => option.label)
						: recommended[0] === undefined
							? []
							: [recommended[0].label],
					custom: "",
				},
			];
		}),
	);
}

/**
 * A recommendation starts checked, but it has no effect until the reader submits or skips explicitly.
 * The host answer identity is captured with the form, so a later snapshot cannot retarget the call.
 */
export function QuestionForm({
	question,
	locale,
	sessionId,
	readOnly,
	actions,
}: QuestionFormProps) {
	const [drafts, setDrafts] = useState(() => initialDrafts(question));
	const [error, setError] = useState("");
	const copy = useMemo(
		() =>
			locale === "zh"
				? {
						title: "需要你回答",
						custom: "补充或填写自己的回答",
						skip: "跳过",
						submit: "提交回答",
						required: "请回答每个问题，或选择跳过。",
					}
				: {
						title: "Your input is needed",
						custom: "Add details or your own answer",
						skip: "Skip",
						submit: "Submit answer",
						required: "Answer each question or choose Skip.",
					},
		[locale],
	);

	const setChoice = (
		questionId: string,
		option: string,
		selected: boolean,
		multiSelect: boolean,
	) => {
		setDrafts((current) => {
			const previous = current[questionId] ?? { selected: [], custom: "" };
			const next = multiSelect
				? selected
					? [...previous.selected, option]
					: previous.selected.filter((value) => value !== option)
				: [option];
			return { ...current, [questionId]: { ...previous, selected: next } };
		});
		setError("");
	};

	const setCustom = (questionId: string, custom: string) => {
		setDrafts((current) => ({
			...current,
			[questionId]: {
				...(current[questionId] ?? { selected: [], custom: "" }),
				custom,
			},
		}));
		setError("");
	};

	const answer = (value: Answer) => {
		actions.onPanelAction({
			kind: "command",
			id: QUESTION_ANSWER_ACTION,
			data: JSON.stringify({
				sessionId,
				value: {
					...value,
					question_id: question.question_id,
					request_id: question.request_id,
					proposal_digest: question.proposal_digest,
					generation: question.generation,
				},
			}),
		});
	};

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		if (readOnly) return;
		const answers: UserAnswer[] = question.questions.map((item) => {
			const draft = drafts[item.id] ?? { selected: [], custom: "" };
			return {
				id: item.id,
				selected: [...draft.selected],
				custom: draft.custom,
			};
		});
		if (
			answers.some(
				(item) =>
					(item.selected?.length ?? 0) === 0 &&
					(item.custom?.trim().length ?? 0) === 0,
			)
		) {
			setError(copy.required);
			return;
		}
		setError("");
		answer({ kind: "answered", answers });
	};

	return (
		<form
			className="question-card"
			aria-label={locale === "zh" ? "等待回答" : "Awaiting your answer"}
			onSubmit={submit}
		>
			<h3>{copy.title}</h3>
			{question.questions.map((item, index) => {
				const draft = drafts[item.id] ?? { selected: [], custom: "" };
				return (
					<fieldset key={item.id}>
						<legend>
							{item.header ? `${item.header}：${item.question}` : item.question}
						</legend>
						{(item.options ?? []).map((option) => (
							<label className="question-option" key={option.label}>
								<input
									type={item.multi_select ? "checkbox" : "radio"}
									name={`choice-${index}`}
									value={option.label}
									checked={draft.selected.includes(option.label)}
									disabled={readOnly}
									onChange={(event) =>
										setChoice(
											item.id,
											option.label,
											event.currentTarget.checked,
											item.multi_select === true,
										)
									}
								/>
								<span>
									{option.label}
									{option.description ? (
										<small>{option.description}</small>
									) : null}
								</span>
							</label>
						))}
						<label className="question-custom">
							{copy.custom}
							<textarea
								name={`custom-${index}`}
								maxLength={8000}
								rows={2}
								value={draft.custom}
								disabled={readOnly}
								onChange={(event) =>
									setCustom(item.id, event.currentTarget.value)
								}
							/>
						</label>
					</fieldset>
				);
			})}
			<p role="alert" hidden={error.length === 0}>
				{error}
			</p>
			<div className="approval-actions">
				<button
					type="button"
					className="panel-button weight-line"
					disabled={readOnly}
					onClick={() => answer({ kind: "skipped", answers: [] })}
				>
					{copy.skip}
				</button>
				<button
					type="submit"
					className="panel-button weight-filled"
					disabled={readOnly}
				>
					{copy.submit}
				</button>
			</div>
		</form>
	);
}
