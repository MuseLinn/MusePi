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
import type { Theme } from "../modes/theme/theme";

export interface PendingApproval {
	requestId: string;
	tool: string;
	prompt: string;
	resolve(approved: boolean): void;
}

export interface ApprovalBridge {
	/** UI context injected into the session (approval-select only). */
	uiContext: ExtensionUIContext;
	/** Active approval requests keyed by requestId. */
	pending: Map<string, PendingApproval>;
	/** Answer a pending request. Returns false when unknown/already resolved. */
	resolve(requestId: string, approved: boolean): boolean;
}

let counter = 0;

export function createApprovalBridge(onRequest: (record: PendingApproval) => void): ApprovalBridge {
	const pending = new Map<string, PendingApproval>();

	const uiContext: ExtensionUIContext = {
		// The approval gate awaits this exact select. Any other select (plan
		// mode, etc.) returns undefined — callers treat that as "no choice".
		async select(title, options) {
			const labels = options.map(o => (typeof o === "string" ? o : (o.label ?? "")));
			if (!labels.includes("Approve") || !labels.includes("Deny")) return undefined;
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
		input: () => Promise.resolve(undefined),
		notify: () => {},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: () => Promise.resolve(undefined as never),
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
	};
}
