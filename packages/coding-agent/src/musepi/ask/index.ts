// ============================================================
// Ask — native MusePi ask_user_question tool registration.
//
// Ported from pi-muselinn-harness/ask/index.ts.
// Registers the tool directly as a native MusePi ToolDefinition,
// shown via QuestionDialogComponent through ExtensionContext.ui.custom().
// ============================================================

import { Type } from "typebox";

import { QuestionDialogComponent, type QuestionsDialogResult } from "./dialog.ts";
import {
	CHAT_LABEL,
	collectAnswers,
	formatAnswers,
	normalizeQuestions,
	OTHER_LABEL,
	type QuestionSpec,
} from "./types.ts";

// ── Tool definition ─────────────────────────────────────────

export const musepiAskUserQuestionToolDef = {
	name: "ask_user_question",
	label: "Ask User Question",
	description: "ask_user_question: ask the user 1-4 structured questions (single/multi select, tabbed dialog)",
	promptSnippet: undefined,
	promptGuidelines: [
		"Use ask_user_question when you need the user to pick between concrete options (approaches, targets, yes/no variants)",
		"Ask 1-4 related questions per call; give each a short header (≤12 chars) used as its tab label",
		"Keep options short (2-6) and mutually exclusive; put the recommended option first; use option description for trade-offs",
		"Add option preview (markdown: mockup, code snippet, visual comparison) when seeing the rendered outcome helps the user choose; any preview switches the dialog to a side-by-side layout and lets the user attach per-option notes",
		"Set multi_select: true when several options may apply at once; a free-text Other option is always added automatically",
		"Question texts must be unique per call and option labels unique within a question — duplicates are rejected; labels Other, Chat about this and Submit are reserved",
		"The user may pick Chat about this instead of answering: the answer comes back with kind chat — discuss the question with the user rather than treating it as answered",
		"For purely open-ended input, ask directly in your reply text instead",
	],
	parameters: Type.Object({
		question: Type.Optional(Type.String({ description: "The question to ask (single-question shorthand)" })),
		header: Type.Optional(Type.String({ description: "Short tab label for this question (≤12 chars)" })),
		multi_select: Type.Optional(Type.Boolean({ description: "Allow picking several options (checkbox semantics)" })),
		body: Type.Optional(
			Type.String({ description: "Optional long-form context shown under the question (first 12 lines rendered)" }),
		),
		other_label: Type.Optional(
			Type.String({ description: 'Custom label for the free-text Other option (default "Other")' }),
		),
		other_description: Type.Optional(Type.String({ description: "Custom description line for the Other option" })),
		options: Type.Optional(
			Type.Array(
				Type.Union([
					Type.String(),
					Type.Object({
						label: Type.String(),
						description: Type.Optional(Type.String()),
						preview: Type.Optional(Type.String()),
					}),
				]),
				{
					description:
						"Options for the single question (2-9 items; strings or {label, description?, preview?} — preview is markdown rendered next to the option list)",
				},
			),
		),
		questions: Type.Optional(
			Type.Array(
				Type.Object({
					question: Type.String(),
					header: Type.Optional(Type.String()),
					options: Type.Array(
						Type.Union([
							Type.String(),
							Type.Object({
								label: Type.String(),
								description: Type.Optional(Type.String()),
								preview: Type.Optional(Type.String()),
							}),
						]),
					),
					multi_select: Type.Optional(Type.Boolean()),
					body: Type.Optional(Type.String()),
					other_label: Type.Optional(Type.String()),
					other_description: Type.Optional(Type.String()),
				}),
				{
					description:
						"1-4 questions shown as tabs: [{question, header, options, multi_select?, body?, other_label?, other_description?}]. " +
						'A free-text "Other" option and a "Chat about this" row are appended to every question automatically.',
				},
			),
		),
	}),
	async execute(_toolCallId: string, params: any, _signal: AbortSignal | undefined, _onUpdate: any, ctx: any) {
		let questions: QuestionSpec[];
		try {
			questions = normalizeQuestions(params);
		} catch (err: any) {
			return { content: [{ type: "text" as const, text: err?.message ?? String(err) }] };
		}

		// No UI fallback: render as plain text for the user to answer in their next message.
		if (!ctx?.hasUI) {
			return { content: [{ type: "text" as const, text: questionsAsText(questions) }] };
		}

		// Show the interactive dialog.
		let result: QuestionsDialogResult | undefined;
		try {
			result = await ctx.ui.custom(
				(_tui: any, theme: any, _kb: any, done: (r: QuestionsDialogResult) => void) =>
					new QuestionDialogComponent(questions, theme, done),
			);
		} catch {
			result = undefined;
		}
		if (!result) {
			return { content: [{ type: "text" as const, text: questionsAsText(questions) }] };
		}
		const answered = collectAnswers(questions, result.states, result.cancelled, result.chatIndex);
		const suffix = result.cancelled ? "\n\n(user cancelled the dialog)" : "";
		return {
			content: [{ type: "text" as const, text: formatAnswers(answered) + suffix }],
			details: answersEnvelope(questions, result, answered),
		};
	},
};

// ── Helpers ─────────────────────────────────────────────────

function questionsAsText(questions: QuestionSpec[]): string {
	const parts = questions.map((q, i) => {
		const head = questions.length > 1 ? `Q${i + 1}${q.header ? ` [${q.header}]` : ""}: ${q.question}` : q.question;
		const kind = q.multiSelect ? " (multi-select — pick any number)" : "";
		const body = q.body?.trim() ? `\n${q.body.trim()}` : "";
		const opts = q.options.map((o, j) => `  ${j + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`);
		const otherLabel = q.otherLabel ?? OTHER_LABEL;
		opts.push(`  ${q.options.length + 1}. ${otherLabel} — ${q.otherDescription ?? "free-text answer"}`);
		if (q.allowChat) {
			opts.push(`  ${q.options.length + 2}. ${CHAT_LABEL} — discuss this question instead of answering`);
		}
		return `${head}${kind}${body}\n${opts.join("\n")}`;
	});
	return (
		"Interactive UI is not available in this mode. Please ask the user to answer " +
		"in their next message:\n\n" +
		parts.join("\n\n")
	);
}

function answersEnvelope(
	questions: QuestionSpec[],
	result: QuestionsDialogResult,
	answered: ReturnType<typeof collectAnswers>,
) {
	return {
		cancelled: result.cancelled,
		...(result.chatIndex !== undefined
			? { chat: { questionIndex: result.chatIndex, question: questions[result.chatIndex]?.question } }
			: {}),
		answers: answered,
	};
}
