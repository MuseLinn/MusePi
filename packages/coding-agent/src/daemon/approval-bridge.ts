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
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
} from "../extensibility/extensions/types";
import type { Theme } from "../modes/theme/theme";

export interface PendingApproval {
	requestId: string;
	tool: string;
	prompt: string;
	/** `note` is the operator's free-text reason (TUI ask-dialog "✎ note"
	 *  parity). On DENY it becomes part of the denial the agent sees;
	 *  on approve it is recorded on the request only (the approval label
	 *  contract has no room for it — see the throw path in `select`). */
	resolve(approved: boolean, note?: string): void;
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

/** Wire payload for an `approval-request` push. Shared by the live broadcast,
 *  the subscribe-time replay and the resume snapshot so all three surfaces
 *  carry the same shape. */
export function approvalRequestPayload(record: PendingApproval): {
	requestId: string;
	tool: string;
	args: unknown;
	prompt?: string;
} {
	return { requestId: record.requestId, tool: record.tool, args: null, prompt: record.prompt };
}

/** Wire payload for an `ask-request` push. Multi-question dialogs carry the
 *  questions array; single select/input keep the flat title/options shape. */
export function askRequestPayload(record: PendingAsk):
	| {
			requestId: string;
			title: string;
			options: string[] | null;
			multi: boolean;
			mode: "select" | "input";
	  }
	| { requestId: string; title: string; mode: "dialog"; questions: PendingAsk["questions"] } {
	return record.mode === "dialog"
		? { requestId: record.requestId, title: record.title, mode: "dialog", questions: record.questions }
		: {
				requestId: record.requestId,
				title: record.title,
				options: record.options,
				multi: record.multi,
				mode: record.mode,
			};
}

export interface RecentApprovalResolution {
	requestId: string;
	approved: boolean;
	note?: string;
	at: number;
}

export interface ApprovalBridge {
	/** UI context injected into the session (approval + ask). */
	uiContext: ExtensionUIContext;
	/** Active approval requests keyed by requestId. */
	pending: Map<string, PendingApproval>;
	/** Answer a pending request. Returns false when unknown/already resolved.
	 *  `note` is the operator's free-text reason. */
	resolve(requestId: string, approved: boolean, note?: string): boolean;
	/** Observe additions and resolutions of the authoritative pending table. */
	subscribe(listener: () => void): () => void;
	/** Active ask requests keyed by requestId. */
	pendingAsks: Map<string, PendingAsk>;
	/** Answer a pending ask. Returns false when unknown/already resolved.
	 *  select/input modes take a label/text (string, null cancels); dialog
	 *  mode takes the full ExtensionAskDialogResult shape. */
	resolveAsk(requestId: string, answer: string | ExtensionAskDialogResult | null): boolean;
	/** Recently settled requests (bounded TTL). A client that fetched a
	 *  snapshot before attaching its stream replays these to clear cards that
	 *  were resolved in the snapshot→subscribe window. */
	recentResolutions(): { approvals: RecentApprovalResolution[]; asks: string[] };
}

let counter = 0;

/** Default human-decision budget. A tool call parked on an approval must not
 *  wait forever when every client disconnects or the user walks away. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export interface ApprovalBridgeOptions {
	/** 0 disables the timeout (tests and deliberate always-wait setups). */
	timeoutMs?: number;
}

export function createApprovalBridge(
	onRequest: (record: PendingApproval) => void,
	onAsk: (record: PendingAsk) => void,
	/** Called after an approval is settled. A second resolve on the same
	 *  request never reaches it (the record is already gone). */
	onResolved?: (requestId: string, approved: boolean, note?: string) => void,
	/** Called after an ask is settled, including a cancel (`answer: null`). */
	onAskResolved?: (requestId: string) => void,
	options: ApprovalBridgeOptions = {},
): ApprovalBridge {
	const pending = new Map<string, PendingApproval>();
	const pendingAsks = new Map<string, PendingAsk>();
	const listeners = new Set<() => void>();
	const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const recentApprovals = new Map<string, RecentApprovalResolution>();
	const recentAsks = new Map<string, number>();
	const RECENT_TTL_MS = 60_000;
	const RECENT_MAX = 64;
	const pruneRecent = (): void => {
		const cutoff = Date.now() - RECENT_TTL_MS;
		for (const [requestId, record] of recentApprovals) {
			if (record.at < cutoff) recentApprovals.delete(requestId);
		}
		for (const [requestId, at] of recentAsks) {
			if (at < cutoff) recentAsks.delete(requestId);
		}
		while (recentApprovals.size > RECENT_MAX) {
			const oldest = recentApprovals.keys().next().value;
			if (oldest === undefined) break;
			recentApprovals.delete(oldest);
		}
		while (recentAsks.size > RECENT_MAX) {
			const oldest = recentAsks.keys().next().value;
			if (oldest === undefined) break;
			recentAsks.delete(oldest);
		}
	};
	const rememberApproval = (requestId: string, approved: boolean, note?: string): void => {
		recentApprovals.set(requestId, { requestId, approved, ...(note ? { note } : {}), at: Date.now() });
		pruneRecent();
	};
	const rememberAsk = (requestId: string): void => {
		recentAsks.set(requestId, Date.now());
		pruneRecent();
	};
	const notifyApprovals = (): void => {
		for (const listener of listeners) listener();
	};

	const makeAskId = (): string => `daemon-ask-${Date.now()}-${++counter}`;
	const clearTimer = (requestId: string): void => {
		const timer = timers.get(requestId);
		if (timer !== undefined) clearTimeout(timer);
		timers.delete(requestId);
	};
	const armTimeout = (requestId: string, onTimeout: () => void): void => {
		if (timeoutMs <= 0) return;
		const timer = setTimeout(() => {
			timers.delete(requestId);
			onTimeout();
		}, timeoutMs);
		timer.unref?.();
		timers.set(requestId, timer);
	};

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
				armTimeout(requestId, () => {
					if (!pendingAsks.has(requestId)) return;
					record.resolve(undefined);
					onAskResolved?.(requestId);
					rememberAsk(requestId);
				});
				onAsk(record);
				return await promise;
			}
			const requestId = `daemon-approval-${Date.now()}-${++counter}`;
			const { promise, resolve } = Promise.withResolvers<{ approved: boolean; note?: string }>();
			// The rendered prompt starts with `Allow tool: <name>` (approval.ts
			// formatApprovalPrompt) — parse the tool name for the contract.
			const toolMatch = /^Allow tool: (\S+)/.exec(title);
			const record: PendingApproval = {
				requestId,
				tool: toolMatch?.[1] ?? "unknown",
				prompt: title,
				resolve: (approved: boolean, note?: string) => {
					if (!pending.has(requestId)) return;
					pending.delete(requestId);
					notifyApprovals();
					resolve(note ? { approved, note } : { approved });
				},
			};
			pending.set(requestId, record);
			armTimeout(requestId, () => {
				if (!pending.has(requestId)) return;
				record.resolve(false, "approval timed out");
				onResolved?.(requestId, false, "approval timed out");
				rememberApproval(requestId, false, "approval timed out");
			});
			onRequest(record);
			notifyApprovals();
			const answer = await promise;
			if (!answer.approved && answer.note) {
				// The label contract has no room for a reason, so a noted denial
				// travels as the rejection error instead: the wrapper's catch
				// emits it as the resolved reason and rethrows it, which is the
				// message the agent actually reads.
				throw new Error(`Tool call denied by user: ${record.tool}\n\nUser note: ${answer.note}`);
			}
			return answer.approved ? "Approve" : "Deny";
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
			armTimeout(requestId, () => {
				if (!pendingAsks.has(requestId)) return;
				record.resolve(undefined);
				onAskResolved?.(requestId);
				rememberAsk(requestId);
			});
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
					resolve(typeof answer === "string" || Array.isArray(answer) ? undefined : answer);
				},
			};
			pendingAsks.set(requestId, record);
			armTimeout(requestId, () => {
				if (!pendingAsks.has(requestId)) return;
				record.resolve(undefined);
				onAskResolved?.(requestId);
				rememberAsk(requestId);
			});
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
		resolve(requestId, approved, note) {
			const record = pending.get(requestId);
			if (!record) return false;
			// The record's own resolve() deletes from pending before settling
			// the select promise (double-resolve guard lives there).
			clearTimer(requestId);
			record.resolve(approved, note);
			onResolved?.(requestId, approved, note);
			rememberApproval(requestId, approved, note);
			return true;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
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
			clearTimer(requestId);
			record.resolve(choice);
			onAskResolved?.(requestId);
			rememberAsk(requestId);
			return true;
		},
		recentResolutions() {
			pruneRecent();
			return {
				approvals: [...recentApprovals.values()],
				asks: [...recentAsks.keys()],
			};
		},
	};
}
