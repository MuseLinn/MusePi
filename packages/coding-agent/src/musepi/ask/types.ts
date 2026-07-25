// ============================================================
// Ask — question spec, answer state machine + formatting (pure,
// no host imports).
//
// Ported from pi-muselinn-harness/packages/core/ask/types.ts.
// Shared by the ask_user_question tool and the permission approval
// dialog: one spec format, one per-question answer state machine,
// one answer formatter.
// ============================================================

export interface OptionSpec {
	label: string;
	description?: string;
	/** Markdown preview shown in a side-by-side pane (n key attaches a note). */
	preview?: string;
}

export interface QuestionSpec {
	question: string;
	header?: string;
	options: OptionSpec[];
	multiSelect?: boolean;
	/** Long-form context shown under the question header (first 12 lines). */
	body?: string;
	allowOther?: boolean;
	otherLabel?: string;
	otherDescription?: string;
	allowChat?: boolean;
}

/** Single-select answers are strings; multi-select answers are arrays. */
export type AnswerValue = string | string[];

export type AnswerStatus = "answered" | "skipped" | "cancelled";

export type AnswerKind = "selected" | "skipped" | "cancelled" | "chat";

/** A free-text note the user attached to a preview-bearing option (`n` key). */
export interface AnswerNote {
	optionIndex: number;
	label: string;
	note: string;
}

export interface AnsweredQuestion {
	question: string;
	header?: string;
	answer?: AnswerValue;
	status: AnswerStatus;
	kind: AnswerKind;
	notes?: AnswerNote[];
}

/** Max options shown with digit shortcuts (1-9). */
export const MAX_DIGIT_OPTIONS = 9;

/** Max questions per ask_user_question call. */
export const MAX_QUESTIONS = 4;

/** Max length of a question header (tab label); longer ones are truncated. */
export const MAX_HEADER_LEN = 12;

/** Label of the synthetic free-text option appended when allowOther. */
export const OTHER_LABEL = "Other";

/** Label of the synthetic row appended when allowChat. */
export const CHAT_LABEL = "Chat about this";

/** Label of the submit tab on multi-question dialogs. */
export const SUBMIT_LABEL = "Submit";

export const RESERVED_LABELS: readonly string[] = [OTHER_LABEL, CHAT_LABEL, SUBMIT_LABEL];

/** Min terminal width (columns) for the side-by-side preview layout. */
export const PREVIEW_MIN_WIDTH = 100;

export type AskLayoutMode = "side-by-side" | "stacked";

/** True when any option of the question carries a markdown preview. */
export function hasAnyPreview(spec: QuestionSpec): boolean {
	return spec.options.some((o) => typeof o.preview === "string" && o.preview.trim() !== "");
}

export function decideLayout(terminalWidth: number, preview: boolean): AskLayoutMode {
	return preview && terminalWidth >= PREVIEW_MIN_WIDTH ? "side-by-side" : "stacked";
}

/** Max options rendered at once; the window follows the cursor. */
export const MAX_VISIBLE_OPTIONS = 6;

/** Max body lines rendered under a question; the rest get a "+N more" note. */
export const MAX_BODY_LINES = 12;

export interface OptionWindow {
	start: number;
	end: number;
	hiddenAbove: number;
	hiddenBelow: number;
}

export function optionWindow(cursor: number, total: number, maxVisible: number = MAX_VISIBLE_OPTIONS): OptionWindow {
	if (total <= maxVisible) return { start: 0, end: total, hiddenAbove: 0, hiddenBelow: 0 };
	const half = Math.floor(maxVisible / 2);
	let start = cursor - half;
	let end = start + maxVisible;
	let hiddenAbove = Math.max(0, -start);
	let hiddenBelow = 0;
	if (start < 0) {
		start = 0;
		end = maxVisible;
	} else if (end > total) {
		end = total;
		start = total - maxVisible;
	}
	hiddenAbove = Math.max(0, start);
	hiddenBelow = Math.max(0, total - end);
	return { start, end, hiddenAbove, hiddenBelow };
}

/** Trimmed body split into lines: first MAX_BODY_LINES plus overflow count. */
export function bodyLines(
	body: string | undefined,
	maxLines: number = MAX_BODY_LINES,
): { lines: string[]; hidden: number } {
	if (!body) return { lines: [], hidden: 0 };
	const lines = body.split("\n").map((l) => l.trimEnd());
	if (lines.length <= maxLines) return { lines, hidden: 0 };
	return { lines: lines.slice(0, maxLines), hidden: lines.length - maxLines };
}

export const QUESTION_UNIQUENESS_MESSAGE =
	"Question texts must be unique across questions, and option labels must be unique within each question.";

export const RESERVED_LABEL_MESSAGE = `Option labels must not collide with reserved synthetic labels (${RESERVED_LABELS.join(", ")}).`;

export function questionUniquenessError(specs: QuestionSpec[]): string | null {
	for (let i = 0; i < specs.length; i++) {
		const a = specs[i]!;
		for (let j = i + 1; j < specs.length; j++) {
			if (a.question === specs[j]!.question) {
				return QUESTION_UNIQUENESS_MESSAGE;
			}
		}
		const seen = new Set<string>();
		for (const opt of a.options) {
			if (seen.has(opt.label)) {
				return QUESTION_UNIQUENESS_MESSAGE;
			}
			seen.add(opt.label);
		}
	}
	return null;
}

/** Normalize tool input into QuestionSpec[]. Accepts the array form or single-question shorthand. */
export function normalizeQuestions(input: any): QuestionSpec[] {
	if (!input) throw new Error("ask_user_question requires question(s) and options");

	// Single-question shorthand: question + options at the top level.
	if (input.question && input.options) {
		const spec: QuestionSpec = {
			question: input.question,
			header: input.header,
			options: normalizeOptions(input.options),
			multiSelect: !!input.multi_select,
			body: input.body,
			allowOther: input.allow_other !== false,
			otherLabel: input.other_label,
			otherDescription: input.other_description,
			allowChat: true,
		};
		if (!spec.question.trim()) throw new Error("question is required and must not be empty");
		if (spec.options.length < 1) throw new Error("options must have at least 1 option");
		if (spec.options.length > 9) throw new Error("options must have at most 9 options");
		if (spec.header && spec.header.length > MAX_HEADER_LEN) spec.header = spec.header.slice(0, MAX_HEADER_LEN);
		return [spec];
	}

	// Array form: questions.
	const raw = input.questions ?? input;
	if (!Array.isArray(raw)) throw new Error("ask_user_question: expected questions array or question+options");
	if (raw.length < 1) throw new Error("ask_user_question: at least 1 question is required");
	if (raw.length > MAX_QUESTIONS) throw new Error(`ask_user_question: at most ${MAX_QUESTIONS} questions per call`);

	const specs: QuestionSpec[] = [];
	for (const q of raw) {
		if (!q.question || !q.options) {
			throw new Error("Each question must have a 'question' string and an 'options' array");
		}
		const spec: QuestionSpec = {
			question: q.question,
			header: q.header,
			options: normalizeOptions(q.options),
			multiSelect: !!q.multi_select,
			body: q.body,
			allowOther: q.allow_other !== false,
			otherLabel: q.other_label,
			otherDescription: q.other_description,
			allowChat: true,
		};
		if (!spec.question.trim()) throw new Error("question is required and must not be empty");
		if (spec.options.length < 1) throw new Error("options must have at least 1 option");
		if (spec.options.length > 9) throw new Error("options must have at most 9 options");
		if (spec.header && spec.header.length > MAX_HEADER_LEN) spec.header = spec.header.slice(0, MAX_HEADER_LEN);
		specs.push(spec);
	}

	const err = questionUniquenessError(specs);
	if (err) throw new Error(err);

	return specs;
}

function normalizeOptions(raw: any[]): OptionSpec[] {
	return raw.map((o: any) => {
		if (typeof o === "string") return { label: o };
		if (typeof o === "object" && o.label) return { label: o.label, description: o.description, preview: o.preview };
		throw new Error(`Invalid option: ${JSON.stringify(o)}`);
	});
}

/** Digit key ("1".."9") → option index, or -1 when not applicable. */
export function digitToIndex(data: string, optionCount: number): number {
	if (data.length !== 1) return -1;
	const code = data.charCodeAt(0);
	if (code < 0x31 || code > 0x39) return -1;
	const idx = code - 0x31;
	return idx < optionCount ? idx : -1;
}

/** Move the cursor within [0, optionCount). */
export function moveIndex(cur: number, delta: number, optionCount: number): number {
	const next = cur + delta;
	if (next < 0) return 0;
	if (next >= optionCount) return optionCount - 1;
	return next;
}

export type ActivateResult = "answered" | "toggled" | "edit-other" | "chat" | "noop";

/**
 * Per-question answer state machine (pure).
 */
export class AnswerState {
	/** Cursor index within the option list (includes synthetic Other, Chat rows). */
	cursor = 0;
	/** Indices of selected options (multi-select) or single index (single-select). */
	selected = new Set<number>();
	/** Free-text value for the "Other" option; empty means not committed. */
	otherText = "";
	/** True while the user is editing the Other free-text input. */
	editingOther = false;
	/** True while the user is typing a note on a preview-bearing option. */
	editingNote = false;
	/** Index of the option whose note is being edited. */
	noteTarget = -1;
	/** Per-option notes keyed by option index. */
	readonly notes = new Map<number, string>();
	readonly spec: QuestionSpec;

	constructor(spec: QuestionSpec) {
		this.spec = spec;
	}
	get optionCount(): number {
		return specOptions(this.spec).length + (this.spec.allowOther !== false ? 1 : 0) + (this.spec.allowChat ? 1 : 0);
	}

	isOther(i: number): boolean {
		return i === specOptions(this.spec).length && this.spec.allowOther !== false;
	}

	isChat(i: number): boolean {
		const base = specOptions(this.spec).length + (this.spec.allowOther !== false ? 1 : 0);
		return i === base && !!this.spec.allowChat;
	}

	isSelected(i: number): boolean {
		return this.selected.has(i);
	}

	isAnswered(): boolean {
		if (this.otherText !== "") return true;
		return this.selected.size > 0;
	}

	/** Return the current answer value (undefined when nothing selected). */
	answer(): string | string[] | undefined {
		if (this.otherText !== "") return this.otherText;
		if (this.selected.size === 0) return undefined;
		if (this.spec.multiSelect && this.selected.size > 0) {
			const results = Array.from(this.selected)
				.map((i) => this.labelFor(i))
				.filter((s): s is string => s != null);
			return results;
		}
		const first = Array.from(this.selected)[0];
		return first !== undefined ? this.labelFor(first) : undefined;
	}

	/** Answers with notes (for the details envelope). */
	answerNotes(): AnswerNote[] {
		const out: AnswerNote[] = [];
		for (const [i, note] of this.notes) {
			const label = this.labelFor(i) ?? "";
			if (label) out.push({ optionIndex: i, label, note });
		}
		return out;
	}

	/** Commit free-text Other value. Returns false when empty (stay editing). */
	commitOther(value: string): boolean {
		if (!value.trim()) return false;
		this.otherText = value.trim();
		this.editingOther = false;
		return true;
	}

	cancelOtherEdit(): void {
		this.editingOther = false;
	}

	/** Start editing a note for option i (n key). */
	startNoteEdit(i: number): boolean {
		if (this.isOther(i) || this.isChat(i)) return false;
		if (!this.spec.options[i]?.preview) return false;
		this.editingNote = true;
		this.noteTarget = i;
		return true;
	}

	commitNote(value: string): void {
		const t = value.trim();
		if (t) this.notes.set(this.noteTarget, t);
		else this.notes.delete(this.noteTarget);
		this.editingNote = false;
		this.noteTarget = -1;
	}

	cancelNoteEdit(): void {
		this.editingNote = false;
		this.noteTarget = -1;
	}

	hasPreviewOption(cursor: number): boolean {
		const opt = this.spec.options[cursor];
		return !!opt?.preview;
	}

	moveCursor(delta: number): void {
		this.cursor = moveIndex(this.cursor, delta, this.optionCount);
	}

	toggle(i: number): void {
		if (this.selected.has(i)) this.selected.delete(i);
		else this.selected.add(i);
	}

	/** Activate the option at index i. Returns the result type. */
	activate(i: number): ActivateResult {
		if (this.isOther(i)) {
			this.editingOther = true;
			return "edit-other";
		}
		if (this.isChat(i)) return "chat";
		if (this.spec.multiSelect) return "toggled";
		// Single-select: toggle and commit.
		if (this.selected.has(i)) {
			this.selected.delete(i);
			return "answered";
		}
		this.selected.clear();
		this.selected.add(i);
		return "answered";
	}

	private labelFor(i: number): string | undefined {
		if (this.isOther(i)) return this.otherText || undefined;
		if (this.isChat(i)) return CHAT_LABEL;
		return this.spec.options[i]?.label;
	}
}

function specOptions(spec: QuestionSpec): OptionSpec[] {
	return spec.options;
}

/** Build the AnsweredQuestion list from a dialog result. */
export function collectAnswers(
	questions: QuestionSpec[],
	states: AnswerState[],
	cancelled: boolean,
	chatIndex?: number,
): AnsweredQuestion[] {
	return questions.map((q, i) => {
		const state: AnswerState | undefined = states[i];
		const answer = state?.answer();
		const notes = state?.answerNotes() ?? [];
		const kind: AnswerKind =
			chatIndex === i ? "chat" : answer !== undefined ? "selected" : cancelled ? "cancelled" : "skipped";
		const base = { question: q.question, header: q.header, kind, ...(notes.length > 0 ? { notes } : {}) };
		if (answer !== undefined) return { ...base, answer, status: "answered" as const };
		return { ...base, status: (cancelled ? "cancelled" : "skipped") as AnswerStatus };
	});
}

/**
 * Format collected answers as the tool result text read by the model.
 */
export function formatAnswers(answered: AnsweredQuestion[]): string {
	return answered
		.map((a) => {
			const head = a.header ? `[${a.header}] ` : "";
			if (a.status === "skipped") return `Q: ${head}${a.question}\n  → (skipped)`;
			if (a.status === "cancelled" && a.kind === "cancelled") return `Q: ${head}${a.question}\n  → (cancelled)`;
			if (a.kind === "chat") return `Q: ${head}${a.question}\n  → (chat — discuss this question with the user)`;
			const val =
				a.answer !== undefined ? (Array.isArray(a.answer) ? a.answer.join(", ") : a.answer) : "(no answer)";
			const notes =
				a.notes && a.notes.length > 0 ? a.notes.map((n) => ` (note for ${n.label}: ${n.note})`).join("") : "";
			return `Q: ${head}${a.question}\n  → ${val}${notes}`;
		})
		.join("\n\n");
}
