import { Markdown, t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon } from "../vendor/oc-icons";

/** One option inside a multi-question dialog question. */
export interface AskDialogOption {
	label: string;
	description?: string;
	preview?: string;
}

/** One question inside a multi-question ask dialog (mode "dialog"). */
export interface AskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: AskDialogOption[];
	multi?: boolean;
	recommended?: number;
}

/** Per-question answer submitted back to session.askAnswer (dialog mode). */
export interface AskDialogResultItem {
	id: string;
	question: string;
	options: string[];
	multi: boolean;
	selectedOptions: string[];
	customInput?: string;
	note?: string;
	timedOut?: boolean;
}

/** Ask dialog answer: submit carries per-question results, chat hands off
 *  to the chat loop, null cancels. */
export type AskDialogAnswer =
	| { kind: "submit"; results: AskDialogResultItem[] }
	| { kind: "chat" };

/** One pending ask question pushed by the daemon (TUI ask parity). */
export interface AskRequest {
	requestId: string;
	title: string;
	options: string[] | null;
	multi: boolean;
	mode: "select" | "input" | "dialog";
	/** Multi-question dialog payload (mode === "dialog"). */
	questions: AskDialogQuestion[] | null;
}

/** Answer shape routed to session.askAnswer: a label/text for select/input,
 *  the full AskDialogAnswer for dialog mode, null cancels. */
export type AskAnswer = string | AskDialogAnswer | null;

/** Multi-question dialog answer sent to session.askAnswer. */
export interface AskDialogSubmit {
	kind: "submit";
	results: AskDialogResultItem[];
}

const OTHER_LABEL = "Other (type your own)";

/** localStorage key for in-flight multi-question draft answers — survives
 *  session switches/relaunches until the ask resolves (openchamber
 *  QuestionCard parity: re-opening the same card restores selections). */
const draftKey = (requestId: string): string => `musepi-gui-ask-draft:${requestId}`;

interface AnswerState {
	selected: string[];
	custom: string;
	otherMode: boolean;
	/** Per-question note (harness ask `n` key parity): free text attached to
	 *  the answer, travels as AskDialogResultItem.note. */
	note: string;
	/** Note editor open (toggled by the note button / `n` key). */
	noteOpen: boolean;
}

function initialAnswers(questions: AskDialogQuestion[]): AnswerState[] {
	return questions.map(q => ({
		selected: q.recommended !== undefined && q.recommended >= 0 && q.recommended < q.options.length
			? [q.options[q.recommended]?.label ?? ""].filter(Boolean)
			: [],
		custom: "",
		otherMode: false,
		note: "",
		noteOpen: false,
	}));
}

function loadDraft(requestId: string): AnswerState[] | null {
	try {
		const raw = localStorage.getItem(draftKey(requestId));
		if (!raw) return null;
		const parsed = JSON.parse(raw) as AnswerState[];
		if (!Array.isArray(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function saveDraft(requestId: string, answers: AnswerState[]): void {
	try {
		localStorage.setItem(draftKey(requestId), JSON.stringify(answers));
	} catch {
		// storage full/denied — draft persistence is best-effort
	}
}

function clearDraft(requestId: string): void {
	try {
		localStorage.removeItem(draftKey(requestId));
	} catch {
		// ignore
	}
}

/**
 * Ask card (TUI ask parity): the agent asks a question mid-run. Two shapes:
 * - select/input (single): option rows or free-text input.
 * - dialog (multi-question): each question is a tab plus a Submit tab
 *   (openchamber QuestionCard parity) — per-question option/multi/Other
 *   selection, summary review, one submit for the whole set.
 *
 * Rendered as a floating card INSIDE the composer wrap (openchamber
 * QuestionCard / proma AskUserBanner parity) — above the input, never a
 * centered modal: no backdrop, no focus trap, Escape cancels.
 */
export function AskCard({
	ask,
	onAnswer,
}: {
	ask: AskRequest;
	onAnswer(answer: AskAnswer): void;
}): ReactNode {
	const [custom, setCustom] = useState("");
	const [otherMode, setOtherMode] = useState(false);
	const inputRef = useRef<HTMLInputElement | null>(null);
	const noteInputRef = useRef<HTMLInputElement | null>(null);
	const [answers, setAnswers] = useState<AnswerState[]>(() => {
		if (ask.mode !== "dialog") return [];
		// Restore an in-flight draft (session switch / relaunch) when the
		// question set still matches; otherwise start fresh.
		const draft = loadDraft(ask.requestId);
		const questions = ask.questions ?? [];
		if (draft && Array.isArray(draft) && draft.length === questions.length) return draft;
		return initialAnswers(questions);
	});
	const [activeTab, setActiveTab] = useState(0);
	// Exit animation: answering/cancelling first plays the card's closing
	// animation, then calls onAnswer (the parent unmounts on that call). The
	// ref guards double-fires (Escape while a closing is in flight).
	const [closing, setClosing] = useState(false);
	const closingRef = useRef(false);
	// Two-phase enter (frost composites before the fade — useTwoPhaseEnter
	// contract). The host conditionally mounts on ask arrival; the answer
	// resolves the daemon promise and unmounts immediately.
	const enteredCls = useTwoPhaseEnter(true);
	// onAnswer identity changes every parent render; keep the listener bound
	// once via ref so Escape never goes stale.
	const onAnswerRef = useRef(onAnswer);
	onAnswerRef.current = onAnswer;
	const askRef = useRef(ask);
	askRef.current = ask;
	closingRef.current = closing;

	const isDialog = ask.mode === "dialog";
	const questions = ask.questions ?? [];
	const isSubmitTabRef = useRef(false);

	useEffect(() => {
		setCustom("");
		setOtherMode(false);
		setActiveTab(0);
		if (isDialog) {
			const draft = loadDraft(ask.requestId);
			if (draft && Array.isArray(draft) && draft.length === questions.length) setAnswers(draft);
			else setAnswers(initialAnswers(questions));
		} else {
			setAnswers([]);
		}
	}, [ask.requestId, isDialog]); // eslint-disable-line react-hooks/exhaustive-deps

	// Persist dialog answers as a draft — the card may unmount on session
	// switch and remount later with the same requestId.
	useEffect(() => {
		if (!isDialog) return;
		if (answers.length === 0) return;
		saveDraft(ask.requestId, answers);
	}, [isDialog, answers, ask.requestId]);

	useEffect(() => {
		if (otherMode || ask.mode === "input") inputRef.current?.focus();
	}, [otherMode, ask.mode, ask.requestId]);

	// Keyboard navigation (non-modal: only Escape always cancels; ←/→ and
	// Enter apply to the dialog card and never fire while typing in an input).
	const activeTabRef = useRef(activeTab);
	activeTabRef.current = activeTab;
	const answersRef = useRef(answers);
	answersRef.current = answers;
	const questionsRef = useRef(questions);
	questionsRef.current = questions;
	// submitDialog is defined later in the component body — assign after it.
	const submitDialogRef = useRef<() => void>(() => {});
	// Toggle the current question's note editor (`n` key). Assigned after
	// toggleNote is defined.
	const toggleNoteRef = useRef<(qIndex: number) => void>(() => {});

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				if (!closingRef.current) closeRef.current(null);
				return;
			}
			// Typing in an input/textarea owns its keys.
			const target = e.target as HTMLElement | null;
			if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA")) return;
			const mode = askRef.current.mode;
			if (mode !== "dialog") return;
			const qs = questionsRef.current;
			const tab = activeTabRef.current;
			const total = qs.length + 1;
			if (e.key === "ArrowLeft") {
				// No tab bar on single-question — arrow keys have nothing to
				// move between.
				if (qs.length <= 1) return;
				e.preventDefault();
				setActiveTab(Math.max(0, tab - 1));
			} else if (e.key === "ArrowRight") {
				if (qs.length <= 1) return;
				e.preventDefault();
				setActiveTab(Math.min(total - 1, tab + 1));
			} else if (e.key === "Enter") {
				// Single question (no tab bar): Enter submits directly when
				// answered. Multi-question: only on the Submit tab.
				const onSubmitTab = tab === qs.length;
				if (qs.length > 1 && !onSubmitTab) return;
				e.preventDefault();
				const allAnswered = qs.every((_, i) => {
					const a = answersRef.current[i];
					if (!a) return false;
					return a.otherMode ? a.custom.trim().length > 0 : a.selected.length > 0;
				});
				if (allAnswered) submitDialogRef.current();
			} else if (e.key.toLowerCase() === "n" && !isSubmitTabRef.current) {
				// `n` on a question tab toggles the note editor (harness parity).
				e.preventDefault();
				toggleNoteRef.current(tab);
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	const isOther = (label: string): boolean => /^other\b/i.test(label.trim());

	// ── Dialog (multi-question) ──────────────────────────────────────────
	const totalTabs = questions.length + 1; // questions + Submit
	const isSubmitTab = isDialog && activeTab === questions.length;
	isSubmitTabRef.current = isSubmitTab;
	const currentQuestion = isDialog && !isSubmitTab ? questions[activeTab] : null;
	const currentAnswer = isDialog && !isSubmitTab ? answers[activeTab] : null;

	const setAnswerAt = (index: number, patch: Partial<AnswerState>): void => {
		setAnswers(prev => {
			const next = prev.slice();
			next[index] = { ...next[index]!, ...patch };
			return next;
		});
	};

	const toggleOption = (qIndex: number, label: string): void => {
		const q = questions[qIndex];
		if (!q) return;
		setAnswerAt(qIndex, { otherMode: false });
		const cur = answers[qIndex]?.selected ?? [];
		if (q.multi) {
			const next = cur.includes(label) ? cur.filter(x => x !== label) : [...cur, label];
			setAnswerAt(qIndex, { selected: next });
		} else {
			setAnswerAt(qIndex, { selected: [label] });
		}
	};

	const enterOther = (qIndex: number): void => {
		setAnswerAt(qIndex, { otherMode: true, selected: [] });
		setActiveTab(qIndex);
		requestAnimationFrame(() => inputRef.current?.focus());
	};

	const setOtherText = (qIndex: number, value: string): void => {
		setAnswerAt(qIndex, { custom: value });
	};

	const hasAnswer = (i: number): boolean => {
		const a = answers[i];
		if (!a) return false;
		return a.otherMode ? a.custom.trim().length > 0 : a.selected.length > 0;
	};

	// Uniform close: play the card's exit animation, then deliver the answer
	// (the parent unmounts on that call). Double-fires are ignored while the
	// closing animation is in flight.
	const closeRef = useRef<(answer: AskAnswer) => void>(() => {});
	closeRef.current = (answer: AskAnswer): void => {
		if (closingRef.current) return;
		closingRef.current = true;
		setClosing(true);
		// 140ms exit animation (gui-ask-pop-out), then resolve.
		window.setTimeout(() => onAnswerRef.current(answer), 150);
	};

	const submitDialog = (): void => {
		if (closingRef.current) return;
		const results: AskDialogResultItem[] = questions.map((q, i) => {
			const a = answers[i];
			return {
				id: q.id,
				question: q.question,
				options: q.options.map(o => o.label),
				multi: q.multi ?? false,
				selectedOptions: a?.otherMode ? [] : (a?.selected ?? []),
				...(a?.otherMode && a.custom.trim() ? { customInput: a.custom.trim() } : {}),
				...(a?.note.trim() ? { note: a.note.trim() } : {}),
			};
		});
		clearDraft(ask.requestId);
		closeRef.current({ kind: "submit", results } satisfies AskDialogSubmit);
	};
	submitDialogRef.current = submitDialog;

	// Toggle the per-question note editor (`n` key / note button parity).
	const toggleNote = (qIndex: number): void => {
		const a = answers[qIndex];
		if (!a) return;
		setAnswerAt(qIndex, { noteOpen: !a.noteOpen });
		requestAnimationFrame(() => {
			if (!a.noteOpen) noteInputRef.current?.focus();
		});
	};
	toggleNoteRef.current = toggleNote;

	// Answer with a wrapped callback: dialog submit clears the draft; cancel
	// (null) clears it too — a resolved ask never restores stale selections.
	const answerAndClear = (answer: AskAnswer): void => {
		if (isDialog) clearDraft(ask.requestId);
		closeRef.current(answer);
	};

	// ── Single (select/input) ────────────────────────────────────────────
	const renderSingle = (): ReactNode => {
		if (ask.mode === "input") {
			return (
				<>
					<input
						ref={inputRef}
						className="gui-input w-full"
						value={custom}
						placeholder={t("ask input placeholder")}
						spellCheck={false}
						onChange={e => setCustom(e.target.value)}
						onKeyDown={e => {
							if (e.key === "Enter" && custom.trim()) answerAndClear(custom.trim());
						}}
					/>
					<div className="flex justify-end">
						<button type="button" className="gui-btn" onClick={() => answerAndClear(null)}>
							{t("cancel")}
						</button>
					</div>
				</>
			);
		}
		if (otherMode) {
			return (
				<>
					<div className="gui-ask-reveal">
						<input
							ref={inputRef}
							className="gui-input w-full"
							value={custom}
							placeholder={t("ask input placeholder")}
							spellCheck={false}
							onChange={e => setCustom(e.target.value)}
							onKeyDown={e => {
								if (e.key === "Enter" && custom.trim()) answerAndClear(custom.trim());
							}}
						/>
					</div>
					<div className="flex justify-end gap-2">
						<button type="button" className="gui-btn" onClick={() => setOtherMode(false)}>
							{t("back")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={!custom.trim()}
							onClick={() => answerAndClear(custom.trim())}
						>
							{t("confirm")}
						</button>
					</div>
				</>
			);
		}
		return (
			<div className="gui-ask-opts">
				{(ask.options ?? []).map(label => (
					<button
						key={label}
						type="button"
						className="gui-ask-opt"
						onClick={() => {
							if (isOther(label)) setOtherMode(true);
							else answerAndClear(label);
						}}
					>
						<Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-none opacity-60" />
						<span className="min-w-0 flex-1 text-left">{label}</span>
					</button>
				))}
			</div>
		);
	};

	// ── Dialog body ──────────────────────────────────────────────────────
	const renderDialogBody = (): ReactNode => {
		if (isSubmitTab) {
			return (
				<div className="gui-ask-summary">
					{questions.map((q, i) => (
						<button
							key={q.id}
							type="button"
							className={`gui-ask-summary-row${hasAnswer(i) ? "" : " gui-ask-summary-row--empty"}`}
							onClick={() => setActiveTab(i)}
						>
							<span className="gui-ask-summary-q">{q.header?.trim() || q.question}</span>
							<span className="gui-ask-summary-a">
								{hasAnswer(i)
									? answers[i]?.otherMode
										? answers[i]?.custom.trim()
										: answers[i]?.selected.join(", ")
									: t("no answer")}
							</span>
						</button>
					))}
					<div className="gui-ask-summary-actions">
						<button type="button" className="gui-btn" onClick={() => answerAndClear(null)}>
							{t("cancel")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={questions.some((_, i) => !hasAnswer(i))}
							onClick={submitDialog}
						>
							{t("submit")}
						</button>
					</div>
				</div>
			);
		}
		const q = currentQuestion;
		const a = currentAnswer;
		if (!q || !a) return null;
		// Preview pane (harness ask parity): when any option carries a
		// markdown preview, the question renders left options + right preview.
		// Shows the selected option's preview, falling back to the
		// recommended option, then the first preview-bearing option.
		const previewOption = q.options.find(
			o => a.selected.includes(o.label) && o.preview?.trim(),
		) ?? (q.recommended !== undefined && q.recommended >= 0
			? q.options[q.recommended]
			: undefined
		) ?? q.options.find(o => o.preview?.trim());
		const hasPreview = q.options.some(o => o.preview?.trim());
		const previewText = previewOption?.preview?.trim() ?? "";
		const qIndex = questions.indexOf(q);
		const optionsCol = (
			<>
				{q.multi && <div className="gui-ask-multi-hint">{t("select multiple")}</div>}
				<div className={`gui-ask-opts${hasPreview ? " gui-ask-opts--preview" : ""}`}>
					{q.options.map(opt => {
						const selected = a.selected.includes(opt.label);
						const recommended = q.recommended === q.options.indexOf(opt);
						const hasOptPreview = !!opt.preview?.trim();
						return (
							<button
								key={opt.label}
								type="button"
								className={`gui-ask-opt${selected ? " gui-ask-opt--selected" : ""}${
									hasPreview && hasOptPreview && previewOption === opt ? " gui-ask-opt--previewed" : ""
								}${recommended ? " gui-ask-opt--rec" : ""}`}
								onClick={() => toggleOption(qIndex, opt.label)}
							>
								{recommended && (
									<span className="gui-ask-opt-rec" aria-label={t("recommended")} title={t("recommended")}>
										<Icon name="star-fill" className="h-2.5 w-2.5" />
									</span>
								)}
								<span className={`gui-ask-opt-check${selected ? " gui-ask-opt-check--on" : ""}`}>
									{q.multi ? (
										selected ? <Icon name="checkbox-multiple" className="h-3.5 w-3.5" /> : null
									) : selected ? (
										<Icon name="checkbox-circle" className="h-3.5 w-3.5" />
									) : null}
								</span>
								<span className="gui-ask-opt-label">
									<span className="min-w-0 flex-1">{opt.label}</span>
									{hasOptPreview && !hasPreview && (
										<span className="gui-ask-opt-preview-tag" title={opt.preview}>
											<Icon name="eye" className="h-3 w-3" />
										</span>
									)}
								</span>
								{opt.description && (
									<span className="gui-ask-opt-desc">{opt.description}</span>
								)}
							</button>
						);
					})}
					<button
						type="button"
						className={`gui-ask-opt${a.otherMode ? " gui-ask-opt--selected" : ""}`}
						onClick={() => enterOther(qIndex)}
					>
						<Icon name="arrow-right-s" className="h-3.5 w-3.5 flex-none opacity-60" />
						<span className="min-w-0 flex-1 text-left">{OTHER_LABEL}</span>
					</button>
					{a.otherMode && (
						<div className="gui-ask-reveal">
							<input
								ref={inputRef}
								className="gui-input w-full"
								value={a.custom}
								placeholder={t("ask input placeholder")}
								spellCheck={false}
								onChange={e => setOtherText(qIndex, e.target.value)}
							/>
						</div>
					)}
					<div className="gui-ask-opt-row">
						<button
							type="button"
							className={`gui-ask-note-btn${a.noteOpen ? " gui-ask-note-btn--open" : ""}${a.note.trim() ? " gui-ask-note-btn--filled" : ""}`}
							onClick={() => toggleNote(qIndex)}
							title={`${t("add note")} (N)`}
						>
							<Icon name="sticky-note" className="h-3 w-3" />
							<span>{a.note.trim() ? t("note") : t("add note")}</span>
						</button>
						<button
							type="button"
							className="gui-ask-chat-btn"
							onClick={() => answerAndClear({ kind: "chat" })}
							title={t("chat about this")}
						>
							<Icon name="chat-1" className="h-3 w-3" />
							<span>{t("chat about this")}</span>
						</button>
					</div>
					{a.noteOpen && (
						<div className="gui-ask-reveal">
							<input
								ref={noteInputRef}
								className="gui-input w-full"
								value={a.note}
								placeholder={t("note placeholder")}
								spellCheck={false}
								onChange={e => setAnswerAt(qIndex, { note: e.target.value })}
								onKeyDown={e => {
									if (e.key === "Enter") toggleNote(qIndex);
								}}
							/>
						</div>
					)}
					{/* Single-question dialog: no tab bar (the Submit tab only
					 * exists for multi-question/multi-select), so the submit
					 * button lives inline here. */}
					{questions.length === 1 && (
						<div className="gui-ask-summary-actions">
							<button type="button" className="gui-btn" onClick={() => answerAndClear(null)}>
								{t("cancel")}
							</button>
							<button
								type="button"
								className="gui-btn gui-btn-primary"
								disabled={!hasAnswer(qIndex)}
								onClick={submitDialog}
							>
								{t("submit")}
							</button>
						</div>
					)}
				</div>
			</>
		);
		if (!hasPreview) return optionsCol;
		return (
			<div className="gui-ask-dialog-preview">
				<div className="gui-ask-dialog-preview-left">{optionsCol}</div>
				<div className="gui-ask-dialog-preview-pane">
					{previewText ? (
						<Markdown text={previewText} />
					) : (
						<span className="gui-ask-dialog-preview-empty">{t("preview empty")}</span>
					)}
				</div>
			</div>
		);
	};

	return (
		<div
			className={`gui-ask-card${enteredCls ? " gui-ask-card--entered" : ""}${
				closing ? " gui-ask-card--closing" : ""
			}${
				isDialog && !isSubmitTab && (currentQuestion?.options.some(o => o.preview?.trim()) ?? false)
					? " gui-ask-card--preview"
					: ""
			}`}
			role="dialog"
			aria-label={ask.title}
		>
			<div className="gui-ask-card-head">
				<Icon name="chat-1" className="h-3.5 w-3.5 flex-none opacity-70" />
				<span className="gui-ask-card-title">
					{isDialog && !isSubmitTab ? questions[activeTab]?.question ?? ask.title : ask.title}
				</span>
				<button
					type="button"
					className="gui-ask-card-x"
					aria-label={t("cancel")}
					title={t("cancel")}
					onClick={() => answerAndClear(null)}
				>
					<Icon name="close" className="h-3 w-3" />
				</button>
			</div>
			{isDialog ? (
				<>
					{totalTabs > 2 && (
						<div className="gui-ask-tabs" role="tablist" aria-label={t("questions")}>
							{questions.map((q, i) => (
								<button
									key={q.id}
									type="button"
									role="tab"
									aria-selected={activeTab === i}
									className={`gui-ask-tab${activeTab === i ? " gui-ask-tab--active" : ""}${
										hasAnswer(i) ? " gui-ask-tab--done" : ""
									}`}
									onClick={() => setActiveTab(i)}
								>
									{q.header?.trim() || `Q${i + 1}`}
								</button>
							))}
							<button
								type="button"
								role="tab"
								aria-selected={isSubmitTab}
								className={`gui-ask-tab gui-ask-tab--submit${isSubmitTab ? " gui-ask-tab--active" : ""}`}
								onClick={() => setActiveTab(questions.length)}
							>
								<Icon name="list-check-2" className="h-3 w-3" />
								{t("submit")}
							</button>
							<span className="gui-ask-progress" aria-live="polite">
								{t("answered {count} of {total}", {
									count: String(questions.filter((_, i) => hasAnswer(i)).length),
									total: String(questions.length),
								})}
							</span>
						</div>
					)}
					{/* Keyboard hint matches the mode: multi-question shows tab
					 * navigation + submit-on-summary; single-question (no tab
					 * bar) shows Enter submits directly. */}
					{isDialog && (
						<div className="gui-ask-kbd-hint" aria-hidden>
							{totalTabs > 2 ? (
								<>
									<span>← →</span>
									{t("switch question")}
									<span>Enter</span>
									{t("submit on summary")}
									<span>Esc</span>
									{t("cancel")}
								</>
							) : (
								<>
									<span>Enter</span>
									{t("submit")}
									<span>Esc</span>
									{t("cancel")}
								</>
							)}
						</div>
					)}
					{/* Keyed by the active tab so switching re-mounts the body and
					 * plays the slide/fade-in (gui-ask-body-in). */}
					<div key={activeTab} className="gui-ask-body">
						{renderDialogBody()}
					</div>
				</>
			) : (
				renderSingle()
			)}
		</div>
	);
}
