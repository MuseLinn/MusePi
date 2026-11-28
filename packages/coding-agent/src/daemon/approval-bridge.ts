/**
 * Daemon approval bridge — the GUI's tool-approval gate.
 *
 * The agent runtime pauses tool execution on `ExtensionUIContext.select`
 * (extensions/wrapper.ts approval gate, "Approve"/"Deny" pair). This module
 * provides that UI context for daemon sessions: the approval select records
 * a pending request and returns a promise that only resolves when a GUI
 * client answers via `tool.approve` / `tool.deny` (daemon RPC → resolve).
 *
 * Only the approval select, generic ask prompts and the agent-secret card are
 * implemented; every other UI-context method is a no-op so interactive-only
 * tools degrade to "no UI" behaviour instead of hanging. (The wrapper also
 * emits `tool_approval_requested` before select, but the ExtensionRunner is
 * internal to session creation — the daemon cannot subscribe, so the request
 * carries the rendered prompt only.)
 */
import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
} from "../extensibility/extensions/types";
import type { Theme } from "../render/theme/theme";
import type { AgentSecretAnswer, AgentSecretRequest, AgentSecretUIContext } from "../secrets/agent-store";

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

/**
 * A `request_secret` call parked on user input. `name`/`purpose` come from the
 * tool; the value never enters this record. The daemon's SecretService answers
 * it (persisting a `save` itself), then resolves the promise the tool awaits.
 */
export interface PendingSecret {
	requestId: string;
	name: string;
	purpose: string;
	/** `fill` collects a value; `allow` extends scope; `login` collects a sign-in. */
	kind: "fill" | "allow" | "login";
	/** Delivery a new save should use. */
	delivery: "env" | "file";
	/** For `login`: the site the agent is on. */
	site?: string;
	/** Entries the user may reuse instead of retyping a value. */
	alternatives?: Array<{ name: string; purpose: string; site?: string; username?: string }>;
	/** Asking session's working directory, in the tool's own form. */
	workspace?: string;
	resolve(answer: AgentSecretAnswer): void;
}

/** Wire payload for a `secret-request` push; shared by live broadcast and replay. */
export function secretRequestPayload(record: PendingSecret): {
	requestId: string;
	name: string;
	purpose: string;
	kind: "fill" | "allow" | "login";
	delivery: "env" | "file";
	site?: string;
	alternatives?: Array<{ name: string; purpose: string; site?: string; username?: string }>;
} {
	return {
		requestId: record.requestId,
		name: record.name,
		purpose: record.purpose,
		kind: record.kind,
		delivery: record.delivery,
		...(record.site ? { site: record.site } : {}),
		...(record.alternatives?.length ? { alternatives: record.alternatives } : {}),
	};
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

/** One parked `connector_catalog` action `request`, waiting for the user. */
export interface PendingConnectorRequest {
	requestId: string;
	/** Catalog id, exactly as the catalog reports it. */
	id: string;
	name: string;
	/** Why the agent wants it, in its own words. */
	purpose: string;
	/** How this connector signs in, so the card can say what the click does. */
	authMode: "oauth" | "none" | "token";
	resolve(decision: "connect" | "decline"): void;
}

/** What the tool asks the host for; mirrors `AgentSecretUIContext`. */
export interface ConnectorRequestAsk {
	id: string;
	name: string;
	purpose: string;
	authMode: "oauth" | "none" | "token";
}

/**
 * Duck-typed extension of the host UI context used by the daemon bridge.
 *
 * The answer is only the user's decision. Enabling the connector happens in
 * the service, so a card cannot put the session in a state the settings page
 * could not reach.
 */
export interface ConnectorRequestUIContext {
	requestConnector?(ask: ConnectorRequestAsk): Promise<"connect" | "decline">;
}

/** Wire payload for a `connector-request` push; shared by live broadcast and replay. */
export function connectorRequestPayload(record: PendingConnectorRequest): {
	requestId: string;
	id: string;
	name: string;
	purpose: string;
	authMode: "oauth" | "none" | "token";
} {
	return {
		requestId: record.requestId,
		id: record.id,
		name: record.name,
		purpose: record.purpose,
		authMode: record.authMode,
	};
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
	/** UI context injected into the session (approval + ask + secret). */
	uiContext: ExtensionUIContext;
	/** Active approval requests keyed by requestId. */
	pending: Map<string, PendingApproval>;
	/** Answer a pending request. Returns false when unknown/already resolved.
	 *  `note` is the operator's free-text reason. */
	resolve(requestId: string, approved: boolean, note?: string): boolean;
	/** Tool names this session has chosen to stop asking about.
	 *
	 *  Session-scoped on purpose: "always allow this tool" is a decision about the
	 *  work in front of the user, not a standing policy — the persistent form of
	 *  that decision is `tools.approvalMode`, and mixing the two would let one
	 *  click quietly widen every later session. */
	allowedTools: Set<string>;
	/** Observe additions and resolutions of the authoritative pending table. */
	subscribe(listener: () => void): () => void;
	/** Active ask requests keyed by requestId. */
	pendingAsks: Map<string, PendingAsk>;
	/** Answer a pending ask. Returns false when unknown/already resolved.
	 *  select/input modes take a label/text (string, null cancels); dialog
	 *  mode takes the full ExtensionAskDialogResult shape. */
	resolveAsk(requestId: string, answer: string | ExtensionAskDialogResult | null): boolean;
	/** Active secret requests keyed by requestId. */
	pendingSecrets: Map<string, PendingSecret>;
	/** Answer a pending secret request. Persistence happens in SecretService
	 *  before this settlement; the tool only learns which action won. */
	resolveSecret(requestId: string, action: AgentSecretAnswer["action"], picked?: string): boolean;
	/** Active connector requests keyed by requestId. */
	pendingConnectors: Map<string, PendingConnectorRequest>;
	/** Answer a pending connector request. The card decides connect-or-decline;
	 *  enabling happens in the service, so this only settles the wait. */
	resolveConnector(requestId: string, decision: "connect" | "decline"): boolean;
	/** Recently settled requests (bounded TTL). A client that fetched a
	 *  snapshot before attaching its stream replays these to clear cards that
	 *  were resolved in the snapshot→subscribe window. */
	recentResolutions(): {
		approvals: RecentApprovalResolution[];
		asks: string[];
		secrets: string[];
		connectors: string[];
	};
}

let counter = 0;

/** Default human-decision budget. A tool call parked on an approval must not
 *  wait forever when every client disconnects or the user walks away. */
export const DEFAULT_APPROVAL_TIMEOUT_MS = 10 * 60_000;

export interface ApprovalBridgeOptions {
	/** 0 disables the timeout (tests and deliberate always-wait setups). */
	timeoutMs?: number;
	/** Push a newly parked secret request to subscribers. */
	onSecretRequest?: (record: PendingSecret) => void;
	/** Called after a secret request settles, including the timeout cancel. */
	onSecretResolved?: (requestId: string) => void;
	/** Push a newly parked connector request to subscribers. */
	onConnectorRequest?: (record: PendingConnectorRequest) => void;
	/** Called after a connector request settles, including the timeout decline. */
	onConnectorResolved?: (requestId: string) => void;
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
	/** Tools allowed for the rest of this session (see `ApprovalBridge`). */
	const allowedTools = new Set<string>();
	const pendingAsks = new Map<string, PendingAsk>();
	const pendingSecrets = new Map<string, PendingSecret>();
	const pendingConnectors = new Map<string, PendingConnectorRequest>();
	const listeners = new Set<() => void>();
	const timeoutMs = options.timeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS;
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const recentApprovals = new Map<string, RecentApprovalResolution>();
	const recentAsks = new Map<string, number>();
	const recentSecrets = new Map<string, number>();
	const recentConnectors = new Map<string, number>();
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
		for (const [requestId, at] of recentSecrets) {
			if (at < cutoff) recentSecrets.delete(requestId);
		}
		for (const [requestId, at] of recentConnectors) {
			if (at < cutoff) recentConnectors.delete(requestId);
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
		while (recentSecrets.size > RECENT_MAX) {
			const oldest = recentSecrets.keys().next().value;
			if (oldest === undefined) break;
			recentSecrets.delete(oldest);
		}
		while (recentConnectors.size > RECENT_MAX) {
			const oldest = recentConnectors.keys().next().value;
			if (oldest === undefined) break;
			recentConnectors.delete(oldest);
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
	const rememberSecret = (requestId: string): void => {
		recentSecrets.set(requestId, Date.now());
		pruneRecent();
	};
	const rememberConnector = (requestId: string): void => {
		recentConnectors.set(requestId, Date.now());
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

	const uiContext: ExtensionUIContext & AgentSecretUIContext & ConnectorRequestUIContext = {
		// A page that holds the turn is answered through the GUI's widget card.
		widgetAnswers: true,
		// The approval gate awaits this exact select; any OTHER select (ask
		// tool questions, plan pickers) routes to the GUI ask card.
		async select(title, options, dialogOptions) {
			const labels = options.map(o => (typeof o === "string" ? o : (o.label ?? "")));
			// The caller states intent; the labels are display text and may be in any
			// language. Sniffing "Approve"/"Deny" made translating them a breaking
			// change — a translated approval would have arrived as an ordinary ask.
			if (dialogOptions?.purpose !== "approval") {
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
			// A tool this session already allowed answers without a card. The
			// decision is still recorded so the transcript shows why it passed.
			const allowedTool = /^Allow tool: (\S+)/.exec(title)?.[1];
			if (allowedTool && allowedTools.has(allowedTool)) {
				rememberApproval(`session-allow-${allowedTool}`, true, "allowed for this session");
				return "Approve";
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
		async requestSecret(request: AgentSecretRequest) {
			const requestId = `daemon-secret-${Date.now()}-${++counter}`;
			const { promise, resolve } = Promise.withResolvers<AgentSecretAnswer | undefined>();
			const record: PendingSecret = {
				requestId,
				name: request.name,
				purpose: request.purpose,
				kind: request.kind,
				delivery: request.delivery ?? "env",
				...(request.site ? { site: request.site } : {}),
				...(request.alternatives?.length ? { alternatives: request.alternatives } : {}),
				...(request.workspace ? { workspace: request.workspace } : {}),
				resolve: answer => {
					if (!pendingSecrets.has(requestId)) return;
					pendingSecrets.delete(requestId);
					notifyApprovals();
					resolve(answer);
				},
			};
			pendingSecrets.set(requestId, record);
			armTimeout(requestId, () => {
				// Walking away is a cancel, never an implicit save.
				if (!pendingSecrets.has(requestId)) return;
				record.resolve({ action: "cancel" });
				options.onSecretResolved?.(requestId);
				rememberSecret(requestId);
			});
			options.onSecretRequest?.(record);
			notifyApprovals();
			return await promise;
		},
		async requestConnector(ask) {
			const requestId = `daemon-connector-${Date.now()}-${++counter}`;
			const { promise, resolve } = Promise.withResolvers<"connect" | "decline">();
			const record: PendingConnectorRequest = {
				requestId,
				id: ask.id,
				name: ask.name,
				purpose: ask.purpose,
				authMode: ask.authMode,
				resolve: decision => {
					if (!pendingConnectors.has(requestId)) return;
					pendingConnectors.delete(requestId);
					notifyApprovals();
					resolve(decision);
				},
			};
			pendingConnectors.set(requestId, record);
			armTimeout(requestId, () => {
				// Walking away is a decline, never an implicit connect.
				if (!pendingConnectors.has(requestId)) return;
				record.resolve("decline");
				options.onConnectorResolved?.(requestId);
				rememberConnector(requestId);
			});
			options.onConnectorRequest?.(record);
			notifyApprovals();
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
		allowedTools,
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
		pendingSecrets,
		resolveSecret(requestId, action, picked) {
			const record = pendingSecrets.get(requestId);
			if (!record) return false;
			clearTimer(requestId);
			record.resolve({ action, ...(picked ? { picked } : {}) });
			options.onSecretResolved?.(requestId);
			rememberSecret(requestId);
			return true;
		},
		pendingConnectors,
		resolveConnector(requestId, decision) {
			const record = pendingConnectors.get(requestId);
			if (!record) return false;
			clearTimer(requestId);
			record.resolve(decision);
			options.onConnectorResolved?.(requestId);
			rememberConnector(requestId);
			return true;
		},
		recentResolutions() {
			pruneRecent();
			return {
				approvals: [...recentApprovals.values()],
				asks: [...recentAsks.keys()],
				secrets: [...recentSecrets.keys()],
				connectors: [...recentConnectors.keys()],
			};
		},
	};
}
