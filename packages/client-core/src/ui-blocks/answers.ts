/**
 * Answers to a UI block's controls.
 *
 * A block lives in a reply's HTML, and that HTML is regenerated whenever the
 * message re-renders. So the answers live here — keyed by the block's hash —
 * and the DOM is re-hydrated from this store after every render. Rendering
 * from the store also means the replies stay consistent with what was chosen
 * when the transcript virtualizes them back in.
 *
 * One block collects its decisions and sends them as ONE message: a user who
 * picks four options must not start four turns, and the agent must see the
 * whole decision at once to answer it coherently.
 */

import { t } from "../i18n/index.js";

/** Window event a host listens for to deliver an answer into the session. */
export const UI_BLOCK_ANSWER_EVENT = "musepi-ui-block-answer";

/** Automatic repair is attempted once per error signature, ever: a failed
 *  regeneration that produces the same errors must not loop the session. */
const REPAIR_STORAGE = "musepi.genui.auto-repair.v1";

function readRepaired(): string[] {
	try {
		const raw = globalThis.localStorage?.getItem(REPAIR_STORAGE);
		const parsed: unknown = raw ? JSON.parse(raw) : [];
		return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function signature(errors: readonly string[]): string {
	let hash = 0x811c9dc5;
	for (const text of errors) {
		for (let index = 0; index < text.length; index += 1) {
			hash ^= text.charCodeAt(index);
			hash = Math.imul(hash, 0x01000193);
		}
	}
	return (hash >>> 0).toString(36);
}

export interface UiBlockAnswerDetail {
	/** The message text to send as the user's next turn. */
	text: string;
}

interface BlockAnswers {
	/** control name → its decision label and chosen value. The label is what the
	 *  agent reads; the name only keys the control. */
	values: Map<string, { decision: string; value: string }>;
	/** The block's own note field, when the user wrote one. */
	note: string;
	/** Decision labels in the order the block declared them. */
	decisions: string[];
	/** True once an answer has been sent; the block then reads as settled. */
	sent: boolean;
}

const blocks = new Map<string, BlockAnswers>();

/**
 * A block that could not draw keeps its source and reasons here, because the
 * repair message has to quote both and the click arrives long after the render.
 */
const failures = new Map<string, { source: string; errors: readonly string[] }>();

export function rememberBlockFailure(hash: string, source: string, errors: readonly string[]): void {
	if (errors.length > 0) failures.set(hash, { source: source.trim(), errors });
	else failures.delete(hash);
}

function stateFor(hash: string): BlockAnswers {
	let state = blocks.get(hash);
	if (!state) {
		state = { values: new Map(), note: "", decisions: [], sent: false };
		blocks.set(hash, state);
	}
	return state;
}

export function hasAnswers(hash: string): boolean {
	return (blocks.get(hash)?.values.size ?? 0) > 0;
}

export function isSent(hash: string): boolean {
	return blocks.get(hash)?.sent === true;
}

/**
 * Record one control's value. A choice is a decision; an input with no value
 * clears it, so an emptied field is not sent as an empty answer.
 */
export function setAnswer(hash: string, name: string, value: string, decision: string): void {
	const state = stateFor(hash);
	if (!state.decisions.includes(decision)) state.decisions.push(decision);
	if (value) state.values.set(name, { decision, value });
	else state.values.delete(name);
	marks?.();
}

export function setNote(hash: string, note: string): void {
	stateFor(hash).note = note;
	marks?.();
}

/** Compose the message a block sends. Empty when nothing was chosen. */
/**
 * Ask the agent to repair a block that never drew — automatically, once.
 *
 * This mirrors GenUI's auto-repair: the host, not the user, files the evidence;
 * but it is bounded where the reference bounds it — the document must be
 * visible, and one error signature is repaired at most once per browser, so a
 * regeneration that fails the same way stops instead of looping.
 */
function repairText(failure: { source: string; errors: readonly string[] }): string {
	return t("transcript.uiBlockRepairRequest", {
		source: failure.source,
		errors: failure.errors.join("\n"),
	});
}

export function maybeAutoRepair(hash: string): boolean {
	if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
	const failure = failures.get(hash);
	if (!failure || failure.errors.length === 0) return false;
	const key = signature(failure.errors);
	const repaired = readRepaired();
	if (repaired.includes(key)) return false;
	repaired.push(key);
	try {
		globalThis.localStorage?.setItem(REPAIR_STORAGE, JSON.stringify(repaired.slice(-50)));
	} catch {
		// A browser without storage still gets one attempt this page load.
	}
	const text = repairText(failure);
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent<UiBlockAnswerDetail>(UI_BLOCK_ANSWER_EVENT, { detail: { text } }));
	}
	return true;
}

/**
 * Repair every failed block on this surface that has not been repaired before.
 * Called after a commit, while the reply is settled: a streaming block is still
 * arriving and its errors are not final.
 */
export function autoRepairFailedBlocks(root: ParentNode): void {
	for (const button of root.querySelectorAll<HTMLElement>("[data-ui-repair]")) {
		const hash = button.getAttribute("data-ui-repair");
		if (hash) maybeAutoRepair(hash);
	}
}

export function composeAnswer(hash: string): string {
	const state = blocks.get(hash);
	if (!state || state.values.size === 0) return "";
	const lines = [...state.values.values()].map(({ decision, value }) => `- ${decision}：${value}`);
	const header = t("transcript.uiBlockAnswerHeader");
	const note = state.note.trim() ? `\n${t("transcript.uiBlockAnswerNote")}：${state.note.trim()}` : "";
	return `${header}\n${lines.join("\n")}${note}`;
}

/** Mark the block settled and hand its message to the host. */
export function sendAnswer(hash: string): boolean {
	const text = composeAnswer(hash);
	if (!text) return false;
	stateFor(hash).sent = true;
	marks?.();
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent<UiBlockAnswerDetail>(UI_BLOCK_ANSWER_EVENT, { detail: { text } }));
	}
	return true;
}

/** Re-read a block's state; the view subscribes so the DOM can follow. */
let marks: (() => void) | null = null;

export function setAnswerMarks(redraw: (() => void) | null): void {
	marks = redraw;
}

function readName(element: Element): { hash: string; name: string } | null {
	const host = element.closest<HTMLElement>("[data-ui-block]");
	const name = element.getAttribute("data-ui-name");
	if (!host || !name) return null;
	const hash = host.dataset.uiBlock;
	return hash ? { hash, name } : null;
}

/**
 * Apply this store to a rendered block tree: chosen controls read as chosen,
 * and a sent block reads as settled. Called after every markdown commit,
 * because that commit rewrites the HTML.
 */
export function applyAnswers(root: ParentNode): void {
	for (const host of root.querySelectorAll<HTMLElement>("[data-ui-block]")) {
		const hash = host.dataset.uiBlock;
		if (!hash) continue;
		const state = blocks.get(hash);
		const sent = state?.sent === true;
		host.dataset.uiSent = sent ? "true" : "false";
		host.dataset.uiReady = (state?.values.size ?? 0) > 0 ? "true" : "false";
		for (const control of host.querySelectorAll<HTMLElement>("[data-ui-name]")) {
			const name = control.getAttribute("data-ui-name") ?? "";
			// The note is not a decision: re-applying it from `values` would wipe
			// what the user typed on the next redraw.
			const value =
				control.getAttribute("data-ui-kind") === "note"
					? (state?.note ?? "")
					: (state?.values.get(name)?.value ?? "");
			if (control.tagName === "INPUT" || control.tagName === "TEXTAREA") {
				const field = control as HTMLInputElement | HTMLTextAreaElement;
				if (field.value !== value && !field.matches(":focus")) field.value = value;
				continue;
			}
			const chosen = value !== "" && control.getAttribute("data-ui-value") === value;
			control.dataset.uiChosen = chosen ? "true" : "false";
			control.setAttribute("aria-pressed", chosen ? "true" : "false");
			if (control instanceof HTMLButtonElement) control.disabled = sent;
		}
	}
}

/**
 * Delegated interaction for one click inside a rendered block. Returns whether
 * it consumed the event, so the transcript's own handlers stay untouched.
 */
export function handleAnswerClick(target: Element): boolean {
	// A block that never drew offers a repair, not an answer: the reply has
	// already ended, so the only way to fix it is to say so in the next turn.
	const repair = target.closest<HTMLElement>("[data-ui-repair]");
	if (repair) {
		const hash = repair.getAttribute("data-ui-repair") ?? "";
		const failure = failures.get(hash);
		if (!failure) return false;
		const text = t("transcript.uiBlockRepairRequest", {
			source: failure.source,
			errors: failure.errors.join("\n"),
		});
		if (typeof window !== "undefined") {
			window.dispatchEvent(new CustomEvent<UiBlockAnswerDetail>(UI_BLOCK_ANSWER_EVENT, { detail: { text } }));
		}
		return true;
	}
	const send = target.closest<HTMLElement>("[data-ui-send]");
	if (send) {
		const hash = send.closest<HTMLElement>("[data-ui-block]")?.dataset.uiBlock;
		return hash ? sendAnswer(hash) : false;
	}
	const choice = target.closest<HTMLElement>("[data-ui-choice]");
	if (!choice) return false;
	const read = readName(choice);
	if (!read || isSent(read.hash)) return false;
	const value = choice.getAttribute("data-ui-value") ?? choice.textContent ?? "";
	const decision = choice.getAttribute("data-ui-decision") ?? read.name;
	const multiple = choice.closest("[data-ui-multiple='true']") !== null;
	if (!multiple) setAnswer(read.hash, read.name, value, decision);
	else {
		const current = blocks.get(read.hash)?.values.get(read.name)?.value ?? "";
		const picked = current ? current.split("\u0000").filter(Boolean) : [];
		const next = picked.includes(value) ? picked.filter(item => item !== value) : [...picked, value];
		setAnswer(read.hash, read.name, next.join("\u0000"), decision);
	}
	return true;
}

/** Delegated input for a text field inside a block. */
export function handleAnswerInput(target: Element): boolean {
	const control = target.closest<HTMLElement>("[data-ui-name]");
	if (!control) return false;
	if (control.getAttribute("data-ui-kind") === "note") {
		const hash = control.closest<HTMLElement>("[data-ui-block]")?.dataset.uiBlock;
		if (!hash) return false;
		setNote(hash, (control as HTMLInputElement).value);
		return true;
	}
	const read = readName(control);
	if (!read) return false;
	const decision = control.getAttribute("data-ui-decision") ?? read.name;
	setAnswer(read.hash, read.name, (control as HTMLInputElement).value, decision);
	return true;
}
