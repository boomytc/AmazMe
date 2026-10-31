import type { QuestionAnswer, QuestionView, UserAnswer } from "./generated/contracts.ts";
import type { Locale } from "./locale.ts";

type Answer = Pick<QuestionAnswer, "kind" | "answers">;

/** Drafts live in the retained form; only an explicit click sends an answer or skip. */
export function questionForm(view: QuestionView, locale: Locale, answer: (value: Answer) => void): HTMLFormElement {
	const form = document.createElement("form");
	form.className = "question-card";
	form.setAttribute("aria-label", locale === "zh" ? "等待回答" : "Awaiting your answer");
	const heading = document.createElement("h3");
	heading.textContent = locale === "zh" ? "需要你回答" : "Your input is needed";
	form.append(heading);
	for (const [index, question] of view.questions.entries()) {
		const group = document.createElement("fieldset"), legend = document.createElement("legend");
		legend.textContent = question.header ? `${question.header}：${question.question}` : question.question;
		group.append(legend);
		const recommended = question.options?.filter(option => option.recommended || /\((?:Recommended|推荐)\)$/i.test(option.label)) ?? [];
		for (const option of question.options ?? []) {
			const label = document.createElement("label"), input = document.createElement("input"), copy = document.createElement("span");
			input.type = question.multi_select ? "checkbox" : "radio";
			input.name = `choice-${index}`;
			input.value = option.label;
			input.checked = question.multi_select ? recommended.includes(option) : recommended[0] === option;
			copy.textContent = option.label;
			if (option.description) {
				const detail = document.createElement("small"); detail.textContent = option.description; copy.append(detail);
			}
			label.className = "question-option"; label.append(input, copy); group.append(label);
		}
		const customLabel = document.createElement("label"), custom = document.createElement("textarea");
		custom.name = `custom-${index}`; custom.maxLength = 8000; custom.rows = 2;
		customLabel.textContent = locale === "zh" ? "补充或填写自己的回答" : "Add details or your own answer";
		customLabel.className = "question-custom"; customLabel.append(custom); group.append(customLabel); form.append(group);
	}
	const error = document.createElement("p"); error.setAttribute("role", "alert"); error.hidden = true;
	const actions = document.createElement("div"), skip = document.createElement("button"), submit = document.createElement("button");
	actions.className = "approval-actions"; skip.type = "button"; submit.type = "submit";
	skip.textContent = locale === "zh" ? "跳过" : "Skip"; submit.textContent = locale === "zh" ? "提交回答" : "Submit answer";
	skip.addEventListener("click", () => answer({ kind: "skipped", answers: [] }));
	form.addEventListener("submit", event => {
		event.preventDefault();
		const data = new FormData(form);
		const answers: UserAnswer[] = view.questions.map((question, index) => ({ id: question.id,
			selected: data.getAll(`choice-${index}`).filter((value): value is string => typeof value === "string"),
			custom: String(data.get(`custom-${index}`) ?? "") }));
		if (answers.some(value => !value.selected?.length && !value.custom?.trim())) {
			error.textContent = locale === "zh" ? "请回答每个问题，或选择跳过。" : "Answer each question or choose Skip.";
			error.hidden = false; return;
		}
		error.hidden = true; answer({ kind: "answered", answers });
	});
	actions.append(skip, submit); form.append(error, actions);
	return form;
}
