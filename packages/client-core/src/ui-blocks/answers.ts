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
	/** Notes attached to ONE decision card, keyed by its title. A user who picks
	 *  an almost-right option needs to add a condition to THAT option; a single
	 *  block-wide note would attach it to every card at once. */
	cardNotes: Map<string, string>;
	/** Links already followed with a message, keyed by that message: one click
	 *  is one turn, and a redraw must not offer the same navigation twice. */
	sentLinks: Set<string>;
	/** Which page of each Tabs group is open, keyed by the group's own key. The
	 *  reply's HTML is regenerated on every re-render, so an open page kept in
	 *  the DOM would snap back to the first one as soon as the message scrolls
	 *  out of view and in again. */
	tabs: Map<string, string>;
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

/** A repair asks for one user turn. A second click on the same block must not
 *  repeat it, and an automatic repair spends that one chance too. */
const sentRepairs = new Set<string>();

function emitRepair(text: string): void {
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent<UiBlockAnswerDetail>(UI_BLOCK_ANSWER_EVENT, { detail: { text } }));
	}
}

function setRepairSpent(button: Element, spent: boolean): void {
	const element = button as HTMLElement;
	if (element.dataset) element.dataset.uiSent = spent ? "true" : "false";
	if (typeof HTMLButtonElement !== "undefined" && button instanceof HTMLButtonElement) button.disabled = spent;
}

export function rememberBlockFailure(hash: string, source: string, errors: readonly string[]): void {
	if (errors.length > 0) failures.set(hash, { source: source.trim(), errors });
	else failures.delete(hash);
}

function stateFor(hash: string): BlockAnswers {
	let state = blocks.get(hash);
	if (!state) {
		state = {
			values: new Map(),
			note: "",
			cardNotes: new Map(),
			sentLinks: new Set(),
			tabs: new Map(),
			decisions: [],
			sent: false,
		};
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

/** A note attached to one decision card (its title), not the whole block. */
export function setCardNote(hash: string, card: string, note: string): void {
	const state = stateFor(hash);
	if (note.trim()) state.cardNotes.set(card, note);
	else state.cardNotes.delete(card);
	marks?.();
}

/** Open one page of a Tabs group. Not a decision: switching views answers nothing. */
export function setTab(hash: string, group: string, page: string): void {
	stateFor(hash).tabs.set(group, page);
	marks?.();
}

/** The page a Tabs group was left on, or "" before the reader has switched. */
export function openTab(hash: string, group: string): string {
	return blocks.get(hash)?.tabs.get(group) ?? "";
}

/** Whether any decision in this block has an answer or a card note. */
export function hasAnyAnswer(hash: string): boolean {
	const state = blocks.get(hash);
	if (!state) return false;
	return state.values.size > 0 || state.note.trim() !== "" || state.cardNotes.size > 0;
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

/** Several failed blocks in one reply: each keeps its own source and reasons,
 *  but they travel as one request instead of one user turn per block. */
function repairTextMany(failures: readonly { source: string; errors: readonly string[] }[]): string {
	const blocks = failures
		.map(
			(failure, index) =>
				`${index + 1}.\n\n\`\`\`ui\n${failure.source}\n\`\`\`\n\n${t("transcript.uiBlockRepairErrors")}\n${failure.errors.join("\n")}`,
		)
		.join("\n\n");
	return t("transcript.uiBlockRepairRequestMany", { count: String(failures.length), blocks });
}

export function maybeAutoRepair(hash: string): boolean {
	if (typeof document !== "undefined" && document.visibilityState === "hidden") return false;
	if (sentRepairs.has(hash)) return false;
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
	sentRepairs.add(hash);
	emitRepair(repairText(failure));
	return true;
}

/**
 * Repair every failed block on this surface that has not been repaired before.
 * Called after a commit, only while the reply is settled: a streaming block is
 * still arriving and its errors are not final. One call sends one message for
 * the whole reply, so several failed blocks cost one turn rather than one each.
 */
export function autoRepairFailedBlocks(root: ParentNode): void {
	if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
	const repaired = readRepaired();
	const batch: Array<{ hash: string; failure: { source: string; errors: readonly string[] } }> = [];
	for (const button of root.querySelectorAll<HTMLElement>("[data-ui-repair]")) {
		const hash = button.getAttribute("data-ui-repair");
		if (!hash || sentRepairs.has(hash) || batch.some(item => item.hash === hash)) continue;
		const failure = failures.get(hash);
		if (!failure || failure.errors.length === 0) continue;
		const key = signature(failure.errors);
		if (repaired.includes(key)) continue;
		repaired.push(key);
		batch.push({ hash, failure });
	}
	if (batch.length === 0) return;
	try {
		globalThis.localStorage?.setItem(REPAIR_STORAGE, JSON.stringify(repaired.slice(-50)));
	} catch {
		// A browser without storage still gets one attempt this page load.
	}
	for (const item of batch) sentRepairs.add(item.hash);
	const only = batch[0]?.failure;
	emitRepair(batch.length === 1 && only ? repairText(only) : repairTextMany(batch.map(item => item.failure)));
}

export function composeAnswer(hash: string): string {
	const state = blocks.get(hash);
	if (!state) return "";
	// A card's note sits under the decision it qualifies, indented, so the agent
	// reads "this option — with this condition" as one thought.
	const used = new Set<string>();
	const lines: string[] = [];
	for (const { decision, value } of state.values.values()) {
		lines.push(`- ${decision}：${value}`);
		const cardNote = state.cardNotes.get(decision)?.trim();
		if (cardNote) {
			used.add(decision);
			lines.push(`  ${t("transcript.uiBlockCardNote")}：${cardNote}`);
		}
	}
	// A card answered only with a condition still has to reach the agent: the
	// user named the option in prose, the note is the whole answer.
	for (const [card, text] of state.cardNotes) {
		if (!used.has(card) && text.trim()) lines.push(`- ${card}：${text.trim()}`);
	}
	if (lines.length === 0) return "";
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
		// The answer bar appears as soon as ANY decision or note exists — a card
		// answered only with a note has to be sendable too.
		host.dataset.uiReady = hasAnyAnswer(hash) ? "true" : "false";
		for (const repair of host.querySelectorAll<HTMLElement>("[data-ui-repair]")) {
			setRepairSpent(repair, sentRepairs.has(repair.getAttribute("data-ui-repair") ?? ""));
		}
		for (const control of host.querySelectorAll<HTMLElement>("[data-ui-name]")) {
			const name = control.getAttribute("data-ui-name") ?? "";
			// Notes are not decisions: re-applying one from `values` would wipe
			// what the user typed on the next redraw.
			const kind = control.getAttribute("data-ui-kind");
			const value =
				kind === "note"
					? (state?.note ?? "")
					: kind === "card-note"
						? (state?.cardNotes.get(control.getAttribute("data-ui-card") ?? "") ?? "")
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
		// A link that carries a message is spent once followed: it opened a page
		// and asked a question, and repeating either would be a second turn the
		// user did not ask for.
		for (const link of host.querySelectorAll<HTMLElement>("[data-ui-link-send]")) {
			const message = link.getAttribute("data-ui-message") ?? "";
			const spent = state?.sentLinks.has(message) === true;
			link.dataset.uiChosen = spent ? "true" : "false";
			if (link instanceof HTMLButtonElement) link.disabled = spent || sent;
		}
		applyTabs(host, state);
	}
}

/**
 * Re-open the page each Tabs group was left on. Called from `applyAnswers`
 * because a commit rewrites the whole block's HTML, and the browser then shows
 * the first page again.
 */
function applyTabs(host: Element, state: BlockAnswers | undefined): void {
	if (typeof host.querySelectorAll !== "function") return;
	for (const group of host.querySelectorAll<HTMLElement>("[data-ui-tabs]")) {
		const key = group.getAttribute("data-ui-tabs") ?? "";
		const open = state?.tabs.get(key) ?? group.getAttribute("data-ui-open") ?? "";
		group.setAttribute("data-ui-open", open);
		for (const tab of group.querySelectorAll<HTMLElement>("[data-ui-tab]")) {
			const isOpen = tab.getAttribute("data-ui-tab-page") === open;
			tab.setAttribute("aria-selected", isOpen ? "true" : "false");
			tab.dataset.uiChosen = isOpen ? "true" : "false";
			// Only the open tab is a Tab stop; arrow keys move within the group.
			tab.tabIndex = isOpen ? 0 : -1;
		}
		for (const panel of group.querySelectorAll<HTMLElement>("[data-ui-tab-page]")) {
			if (panel.hasAttribute("data-ui-tab")) continue;
			const isOpen = panel.getAttribute("data-ui-tab-page") === open;
			panel.hidden = !isOpen;
			panel.dataset.open = isOpen ? "true" : "false";
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
		if (sentRepairs.has(hash)) return true;
		sentRepairs.add(hash);
		setRepairSpent(repair, true);
		emitRepair(repairText(failure));
		return true;
	}
	const link = target.closest<HTMLElement>("[data-ui-link-send]");
	if (link) {
		const host = link.closest<HTMLElement>("[data-ui-block]");
		const hash = host?.dataset.uiBlock;
		if (!hash) return false;
		const message = link.getAttribute("data-ui-message") ?? "";
		const href = link.getAttribute("data-ui-href") ?? "";
		const state = stateFor(hash);
		if (!message || state.sentLinks.has(message)) return true;
		state.sentLinks.add(message);
		marks?.();
		if (typeof window !== "undefined") {
			if (href) window.dispatchEvent(new CustomEvent("musepi-open-url", { detail: { url: href } }));
			window.dispatchEvent(
				new CustomEvent<UiBlockAnswerDetail>(UI_BLOCK_ANSWER_EVENT, { detail: { text: message } }),
			);
		}
		return true;
	}
	// A tab switch changes what is visible, not what is answered: it never
	// reaches the answer store as a value.
	const tab = target.closest<HTMLElement>("[data-ui-tab]");
	if (tab) {
		const host = tab.closest<HTMLElement>("[data-ui-block]");
		const hash = host?.dataset.uiBlock;
		const group = tab.getAttribute("data-ui-tab");
		const page = tab.getAttribute("data-ui-tab-page");
		if (!hash || !group || !page) return false;
		setTab(hash, group, page);
		if (host) applyTabs(host, blocks.get(hash));
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
	const kind = control.getAttribute("data-ui-kind");
	if (kind === "note") {
		const hash = control.closest<HTMLElement>("[data-ui-block]")?.dataset.uiBlock;
		if (!hash) return false;
		setNote(hash, (control as HTMLInputElement).value);
		return true;
	}
	if (kind === "card-note") {
		const hash = control.closest<HTMLElement>("[data-ui-block]")?.dataset.uiBlock;
		const card = control.getAttribute("data-ui-card");
		if (!hash || !card) return false;
		setCardNote(hash, card, (control as HTMLInputElement).value);
		return true;
	}
	const read = readName(control);
	if (!read) return false;
	const decision = control.getAttribute("data-ui-decision") ?? read.name;
	setAnswer(read.hash, read.name, (control as HTMLInputElement).value, decision);
	return true;
}
