/**
 * Daemon approval bridge — the GUI's tool-approval gate.
 *
 * The agent runtime pauses tool execution on `ExtensionUIContext.select`
 * (extensions/wrapper.ts approval gate, "Approve"/"Deny" pair). This module
 * provides that UI context for daemon sessions: the approval select records
 * a pending request and returns a promise that only resolves when a GUI
 * client answers via `tool.approve` / `tool.deny` (daemon RPC → resolve).
 *
 * Only the approval surface is implemented; every other UI-context method is
 * a no-op so interactive-only tools degrade to "no UI" behaviour instead of
 * hanging. (The wrapper also emits `tool_approval_requested` before select,
 * but the ExtensionRunner is internal to session creation — the daemon
 * cannot subscribe, so the request carries the rendered prompt only.)
 */
import type { ExtensionUIContext } from "../extensibility/extensions/types";
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
} from "../extensibility/extensions/types";
import type { Theme } from "../modes/theme/theme";

export interface PendingApproval {
	requestId: string;
	tool: string;
	prompt: string;
	resolve(approved: boolean): void;
}

/** Multi-question ask dialog answer (TUI askDialog parity): submit carries
 *  per-question results, chat hands off to the chat loop, undefined cancels.
 *  Single select/input modes answer with a plain label/text string. */
export type PendingAskAnswer = string | ExtensionAskDialogResult | undefined;

export interface PendingAsk {
	requestId: string;
	title: string;
	/** Option labels (select mode) or null (input mode). */
	options: string[] | null;
	/** True for checkbox multi-select (ask `multi: true`). */
	multi: boolean;
	mode: "select" | "input" | "dialog";
	/** Multi-question dialog payload (mode === "dialog"): the questions the
	 *  GUI card renders as tabs; single-select/input modes leave this null. */
	questions: ExtensionAskDialogQuestion[] | null;
	resolve(choice: PendingAskAnswer): void;
}

export interface ApprovalBridge {
	/** UI context injected into the session (approval + ask). */
	uiContext: ExtensionUIContext;
	/** Active approval requests keyed by requestId. */
	pending: Map<string, PendingApproval>;
	/** Answer a pending request. Returns false when unknown/already resolved. */
	resolve(requestId: string, approved: boolean): boolean;
	/** Active ask requests keyed by requestId. */
	pendingAsks: Map<string, PendingAsk>;
	/** Answer a pending ask. Returns false when unknown/already resolved.
	 *  select/input modes take a label/text (string, null cancels); dialog
	 *  mode takes the full ExtensionAskDialogResult shape. */
	resolveAsk(requestId: string, answer: string | ExtensionAskDialogResult | null): boolean;
}

let counter = 0;

export function createApprovalBridge(
	onRequest: (record: PendingApproval) => void,
	onAsk: (record: PendingAsk) => void,
): ApprovalBridge {
	const pending = new Map<string, PendingApproval>();
	const pendingAsks = new Map<string, PendingAsk>();

	const makeAskId = (): string => `daemon-ask-${Date.now()}-${++counter}`;

	const uiContext: ExtensionUIContext = {
		// The approval gate awaits this exact select; any OTHER select (ask
		// tool questions, plan pickers) routes to the GUI ask card.
		async select(title, options) {
			const labels = options.map(o => (typeof o === "string" ? o : (o.label ?? "")));
			if (!labels.includes("Approve") || !labels.includes("Deny")) {
				const requestId = makeAskId();
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				const record: PendingAsk = {
					requestId,
					title,
					options: labels,
					multi: false,
					mode: "select",
					questions: null,
					resolve: (answer: PendingAskAnswer) => {
						if (!pendingAsks.has(requestId)) return;
						pendingAsks.delete(requestId);
						// select/input paths only ever answer with a single label.
						resolve(typeof answer === "string" && answer.length > 0 ? answer : undefined);
					},
				};
				pendingAsks.set(requestId, record);
				onAsk(record);
				return await promise;
			}
			const requestId = `daemon-approval-${Date.now()}-${++counter}`;
			const { promise, resolve } = Promise.withResolvers<boolean>();
			// The rendered prompt starts with `Allow tool: <name>` (approval.ts
			// formatApprovalPrompt) — parse the tool name for the contract.
			const toolMatch = /^Allow tool: (\S+)/.exec(title);
			const record: PendingApproval = {
				requestId,
				tool: toolMatch?.[1] ?? "unknown",
				prompt: title,
				resolve: (approved: boolean) => {
					if (!pending.has(requestId)) return;
					pending.delete(requestId);
					resolve(approved);
				},
			};
			pending.set(requestId, record);
			onRequest(record);
			return (await promise) ? "Approve" : "Deny";
		},
		confirm: () => Promise.resolve(false),
		// Generic ask path: `ui.input` (custom text for "Other", direct
		// prompts) — send an ask-request and wait for session.askAnswer.
		async input(title) {
			const requestId = makeAskId();
			const { promise, resolve } = Promise.withResolvers<string | undefined>();
			const record: PendingAsk = {
				requestId,
				title,
				options: null,
				multi: false,
				mode: "input",
				questions: null,
				resolve: (answer: PendingAskAnswer) => {
					if (!pendingAsks.has(requestId)) return;
					pendingAsks.delete(requestId);
					resolve(typeof answer === "string" && answer.length > 0 ? answer : undefined);
				},
			};
			pendingAsks.set(requestId, record);
			onAsk(record);
			return await promise;
		},
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.resolve(undefined as never),
		// Rich multi-question ask dialog (TUI askDialog parity): the GUI card
		// renders each question as a tab plus a Submit tab; the answer is the
		// full ExtensionAskDialogResult (submit per-question results, or chat
		// redirect), undefined cancels.
		async askDialog(questions) {
			const requestId = makeAskId();
			const { promise, resolve } = Promise.withResolvers<ExtensionAskDialogResult | undefined>();
			const record: PendingAsk = {
				requestId,
				title: questions[0]?.question ?? "询问",
				options: null,
				multi: false,
				mode: "dialog",
				questions,
				resolve: (answer: PendingAskAnswer) => {
					if (!pendingAsks.has(requestId)) return;
					pendingAsks.delete(requestId);
					// dialog mode answers are always ExtensionAskDialogResult
					// (submit/chat) or undefined (cancel) — never a bare string.
					resolve(
						typeof answer === "string" || Array.isArray(answer)
							? undefined
							: answer,
					);
				},
			};
			pendingAsks.set(requestId, record);
			onAsk(record);
			return await promise;
		},
		setEditorText: () => {},
		pasteToEditor: () => {},
		getEditorText: () => "",
		editor: () => Promise.resolve(undefined),
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		theme: {} as Theme,
		getAllThemes: () => Promise.resolve([]),
		getTheme: () => Promise.resolve(undefined),
		setTheme: () => Promise.resolve({ success: false, error: "no UI" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};

	return {
		uiContext,
		pending,
		resolve(requestId, approved) {
			const record = pending.get(requestId);
			if (!record) return false;
			// The record's own resolve() deletes from pending before settling
			// the select promise (double-resolve guard lives there).
			record.resolve(approved);
			return true;
		},
		pendingAsks,
		resolveAsk(requestId, answer) {
			const record = pendingAsks.get(requestId);
			if (!record) return false;
			// dialog mode: the full ExtensionAskDialogResult (submit with
			// per-question results, or chat redirect); null/undefined cancels.
			// select/input modes: a single label/text; null/empty cancels.
			const choice: PendingAskAnswer =
				record.mode === "dialog"
					? (answer ?? undefined)
					: typeof answer === "string" && answer.length > 0
						? answer
						: undefined;
			record.resolve(choice);
			return true;
		},
	};
}
