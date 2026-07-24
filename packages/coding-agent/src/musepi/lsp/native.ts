// ============================================================
// MusePi native LSP integration — host seam.
//
// The engine (JSON-RPC protocol, client registry, server detection,
// diagnostics ledger, deferred coordinator) lives in @musepi/core/lsp
// with zero pi imports. This module owns the fork-side glue:
//   1. the `lsp` tool (diagnostics / definition / references / hover /
//      symbols / status),
//   2. deferred post-mutation diagnostics: a file-mutation listener
//      (armed in file-mutation-queue.ts, covering BOTH the pi-native and
//      the hashline edit paths plus write) asynchronously pulls fresh
//      diagnostics, folds them through the ledger, and queues them;
//   3. the transformContext seam contribution that drains the queue into
//      the outgoing context view as a trailing synthetic user message
//      (non-persistent restatement, same pattern as tool-select).
//
// Graceful degradation: with no detected server every action answers
// with a plain explanation instead of failing the tool call.
// ============================================================

import path from "node:path";
import {
	DeferredDiagnosticsCoordinator,
	dedupeFormattedDiagnostics,
	extractHoverText,
	fileToUri,
	formatDiagnostic,
	formatDocumentSymbols,
	formatLocation,
	formatSymbolInformations,
	getServersForFile,
	type LspClient,
	type LspDocumentSymbol,
	type LspRegistry,
	LspRegistry as LspRegistryCtor,
	type LspSymbolInformation,
	normalizeLocations,
	type ResolvedLspServer,
	renderDeferredDiagnostics,
	resolveLspServers,
	sortDiagnostics,
	summarizeDiagnosticMessages,
	uriToFile,
} from "@musepi/core";
import { Type } from "typebox";
import type { AgentSession } from "../../core/agent-session.ts";
import type { ToolDefinition } from "../../core/extensions/index.ts";
import type { SettingsManager } from "../../core/settings-manager.ts";
import { addFileMutationListener } from "../../core/tools/file-mutation-queue.ts";
import { resolveToCwd } from "../../core/tools/path-utils.ts";

// =============================================================================
// Binding (module singleton, goalManager pattern)
// =============================================================================

interface LspBinding {
	enabled: boolean;
	cwd: string;
	servers: Record<string, ResolvedLspServer>;
	registry: LspRegistry;
	coordinator: DeferredDiagnosticsCoordinator;
	detachMutationListener: (() => void) | null;
}

let binding: LspBinding | null = null;

/** Test hook: run the deferred pipeline against an in-process registry. */
export function initMusepiLspForTest(testBinding: LspBinding): void {
	binding = testBinding;
}

function formatUptime(ms: number): string {
	const seconds = Math.round(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${seconds % 60}s`;
	return `${Math.floor(minutes / 60)}h${minutes % 60}m`;
}

function relativePath(cwd: string, absPath: string): string {
	const rel = path.relative(cwd, absPath);
	return rel.startsWith("..") ? absPath : rel.split(path.sep).join("/");
}

// =============================================================================
// Action helpers
// =============================================================================

function serversForFile(absPath: string): ResolvedLspServer[] {
	if (!binding) return [];
	return getServersForFile(binding.servers, absPath);
}

function noServerMessage(absPath: string): string {
	return (
		`No LSP server available for ${path.basename(absPath)}. A server activates only when its root ` +
		`markers (package.json, tsconfig.json, pyproject.toml, …) intersect the project AND its binary ` +
		`is installed (node_modules/.bin, venv, or $PATH). Use the status action to see what was detected.`
	);
}

async function clientForFile(absPath: string, signal?: AbortSignal): Promise<LspClient | null> {
	if (!binding) return null;
	const servers = serversForFile(absPath);
	const primary = servers[0];
	if (!primary) return null;
	const client = await binding.registry.getOrCreate(primary, binding.cwd, signal);
	await client.ensureFileOpen(absPath);
	return client;
}

function requirePosition(params: { path?: string; line?: number; column?: number }): {
	absPath: string;
	line: number;
	character: number;
} {
	if (!params.path) throw new Error("path is required for this action");
	if (typeof params.line !== "number" || typeof params.column !== "number") {
		throw new Error("line and column (1-based) are required for this action");
	}
	return {
		absPath: resolveToCwd(params.path, binding?.cwd ?? process.cwd()),
		line: Math.max(0, params.line - 1),
		character: Math.max(0, params.column - 1),
	};
}

const DIAGNOSTIC_MESSAGE_LIMIT = 50;
const LOCATION_LIMIT = 50;
const ACTION_DIAGNOSTICS_WAIT_MS = 3000;

async function executeDiagnostics(params: { path?: string }, signal?: AbortSignal): Promise<string> {
	if (!binding) throw new Error("lsp is not initialized");
	if (params.path) {
		const absPath = resolveToCwd(params.path, binding.cwd);
		const client = await clientForFile(absPath, signal);
		if (!client) return noServerMessage(absPath);
		const diagnostics = sortDiagnostics(
			await client.waitForDiagnostics(fileToUri(absPath), { timeoutMs: ACTION_DIAGNOSTICS_WAIT_MS, signal }),
		);
		if (diagnostics.length === 0) return `${relativePath(binding.cwd, absPath)}: no issues`;
		const rel = relativePath(binding.cwd, absPath);
		const lines = dedupeFormattedDiagnostics(diagnostics.map((d) => formatDiagnostic(d, rel)));
		const shown = lines.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
		const { summary } = summarizeDiagnosticMessages(lines);
		const truncation = lines.length > shown.length ? `\n… ${lines.length - shown.length} more not shown` : "";
		return `${rel}: ${summary}\n${shown.join("\n")}${truncation}`;
	}

	// Workspace-wide: aggregate everything currently published to active clients.
	const sections: string[] = [];
	for (const info of binding.registry.activeClients()) {
		if (info.diagnosticUriCount === 0) continue;
		const client = binding.registry.getByKey(info.key);
		if (!client) continue;
		for (const [uri, published] of client.diagnostics) {
			if (published.diagnostics.length === 0) continue;
			const rel = relativePath(binding.cwd, uriToFile(uri));
			const lines = dedupeFormattedDiagnostics(
				sortDiagnostics(published.diagnostics).map((d) => formatDiagnostic(d, rel)),
			);
			sections.push(`${rel}: ${summarizeDiagnosticMessages(lines).summary}\n${lines.join("\n")}`);
		}
	}
	if (sections.length === 0) {
		return "No diagnostics published yet. Run diagnostics with a path to open the file in its language server.";
	}
	return sections.join("\n\n");
}

async function executeLocationAction(
	action: "definition" | "references",
	params: { path?: string; line?: number; column?: number },
	signal?: AbortSignal,
): Promise<string> {
	if (!binding) throw new Error("lsp is not initialized");
	const cwd = binding.cwd;
	const { absPath, line, character } = requirePosition(params);
	const client = await clientForFile(absPath, signal);
	if (!client) return noServerMessage(absPath);
	// No projectLoaded wait: LSP servers queue semantic requests until ready,
	// and the request's own timeout bounds the wait.
	const method = action === "definition" ? "textDocument/definition" : "textDocument/references";
	const requestParams =
		action === "definition"
			? { textDocument: { uri: fileToUri(absPath) }, position: { line, character } }
			: {
					textDocument: { uri: fileToUri(absPath) },
					position: { line, character },
					context: { includeDeclaration: true },
				};
	const result = await client.request(method, requestParams, { signal });
	const locations = normalizeLocations(result as Parameters<typeof normalizeLocations>[0]);
	if (locations.length === 0) return `No ${action} found at ${params.path}:${params.line}:${params.column}.`;
	const formatted = locations.map((loc) => formatLocation(loc, cwd));
	const shown = formatted.slice(0, LOCATION_LIMIT);
	const truncation = formatted.length > shown.length ? `\n… ${formatted.length - shown.length} more not shown` : "";
	return `${locations.length} ${action} location(s):\n${shown.join("\n")}${truncation}`;
}

async function executeHover(
	params: { path?: string; line?: number; column?: number },
	signal?: AbortSignal,
): Promise<string> {
	if (!binding) throw new Error("lsp is not initialized");
	const { absPath, line, character } = requirePosition(params);
	const client = await clientForFile(absPath, signal);
	if (!client) return noServerMessage(absPath);
	const result = await client.request(
		"textDocument/hover",
		{ textDocument: { uri: fileToUri(absPath) }, position: { line, character } },
		{ signal },
	);
	const text = extractHoverText(result as Parameters<typeof extractHoverText>[0]);
	return text.length > 0 ? text : `No hover information at ${params.path}:${params.line}:${params.column}.`;
}

async function executeSymbols(params: { path?: string }, signal?: AbortSignal): Promise<string> {
	if (!binding) throw new Error("lsp is not initialized");
	if (!params.path) throw new Error("path is required for the symbols action");
	const absPath = resolveToCwd(params.path, binding.cwd);
	const client = await clientForFile(absPath, signal);
	if (!client) return noServerMessage(absPath);
	const result = await client.request(
		"textDocument/documentSymbol",
		{ textDocument: { uri: fileToUri(absPath) } },
		{ signal },
	);
	const symbols = Array.isArray(result) ? result : [];
	if (symbols.length === 0) return `No symbols found in ${params.path}.`;
	if ("location" in (symbols[0] as object)) {
		return formatSymbolInformations(symbols as LspSymbolInformation[], binding.cwd).join("\n");
	}
	return formatDocumentSymbols(symbols as LspDocumentSymbol[]).join("\n");
}

function executeStatus(): string {
	if (!binding) throw new Error("lsp is not initialized");
	const lines: string[] = [];
	const active = binding.registry.activeClients();
	if (active.length > 0) {
		lines.push("Active language servers:");
		for (const info of active) {
			lines.push(
				`  ${info.serverName} (${info.source}) — ${info.status}, up ${formatUptime(info.uptimeMs)}, ` +
					`${info.openFileCount} open file(s), root ${info.cwd}`,
			);
		}
	}
	const activeNames = new Set(active.map((info) => info.serverName));
	const detected = Object.values(binding.servers).filter((server) => !activeNames.has(server.name));
	if (detected.length > 0) {
		lines.push("Detected, not started (spawn lazily on first use):");
		for (const server of detected) {
			lines.push(`  ${server.name} (${server.source}) — ${server.resolvedCommand}`);
		}
	}
	if (active.length === 0 && detected.length === 0) {
		lines.push(
			"No LSP servers detected for this project. Detection requires BOTH root markers " +
				"(package.json, tsconfig.json, pyproject.toml, …) and an installed server binary " +
				"(node_modules/.bin, venv, or $PATH).",
		);
	}
	const idle = binding.registry.idleTimeoutMs;
	lines.push(`Idle timeout: ${idle === null ? "disabled" : formatUptime(idle)}`);
	return lines.join("\n");
}

// =============================================================================
// Deferred post-mutation diagnostics
// =============================================================================

const DEFERRED_FETCH_WAIT_MS = 25_000;
/**
 * Inline window (OMP writethrough semantics): the mutation tool result is
 * held this long so a warm server can publish fresh diagnostics BEFORE the
 * agent loop's next request — the transformContext drain then lands them in
 * that very request. Slow servers (first spawn) exceed the window and hand
 * off to the background fetch, landing on a later request/turn instead.
 */
const INLINE_DIAGNOSTICS_WAIT_MS = 2_000;

/**
 * In-flight deferred fetches per file. A newer mutation aborts the previous
 * fetch (OMP begin/abort pattern) so only the freshest batch reaches the
 * ledger — otherwise an aborted-then-stale entry could consume ledger
 * identities and suppress the fresh injection.
 */
const pendingFetches = new Map<string, AbortController>();

async function fetchAndOffer(absPath: string, mutationVersion: number, signal: AbortSignal): Promise<void> {
	if (!binding) return;
	const { cwd, registry, coordinator } = binding;
	try {
		const servers = serversForFile(absPath);
		const primary = servers[0];
		if (!primary) return;
		const fetchSignal = AbortSignal.any([signal, AbortSignal.timeout(DEFERRED_FETCH_WAIT_MS + 8_000)]);
		const client = await registry.getOrCreate(primary, cwd, fetchSignal);
		const version = await client.refreshFile(absPath);
		if (version === null) return; // file deleted
		const diagnostics = await client.waitForDiagnostics(fileToUri(absPath), {
			timeoutMs: DEFERRED_FETCH_WAIT_MS,
			minDocumentVersion: version,
			signal: fetchSignal,
		});
		// No awaits below this point: staleness check → ledger reduce → offer
		// is atomic, so a concurrent newer mutation cannot slip between the
		// check and the ledger update.
		if (coordinator.version(absPath) !== mutationVersion) return;
		const rel = relativePath(cwd, absPath);
		const messages = dedupeFormattedDiagnostics(sortDiagnostics(diagnostics).map((d) => formatDiagnostic(d, rel)));
		const fresh = coordinator.ledger.reduce(absPath, messages);
		if (fresh.messages.length === 0) return; // nothing new — ledger saw it all
		const shown = fresh.messages.slice(0, DIAGNOSTIC_MESSAGE_LIMIT);
		coordinator.offer(
			{
				path: rel,
				messages: shown,
				summary: summarizeDiagnosticMessages(shown).summary,
				errored: fresh.errored,
			},
			absPath,
			mutationVersion,
		);
	} catch {
		// Graceful: a broken/slow/aborted server must never surface as an edit failure.
	}
}

/** Post-mutation hook (armed via file-mutation-queue listener). Exported for tests. */
export function notifyMusepiLspFileMutated(filePath: string): Promise<void> | void {
	if (!binding?.enabled) return;
	// Fast path: no server for this file — never stall the mutation.
	if (serversForFile(filePath).length === 0) return;
	pendingFetches.get(filePath)?.abort();
	const controller = new AbortController();
	pendingFetches.set(filePath, controller);
	const version = binding.coordinator.bumpVersion(filePath);
	const fetch = fetchAndOffer(filePath, version, controller.signal).finally(() => {
		if (pendingFetches.get(filePath) === controller) pendingFetches.delete(filePath);
	});
	// The returned promise only covers the inline window; the fetch itself
	// keeps running in the background when the window expires.
	return Promise.race([fetch, new Promise<void>((resolve) => setTimeout(resolve, INLINE_DIAGNOSTICS_WAIT_MS))]).then(
		() => undefined,
	);
}

/**
 * transformContext seam contribution: drain pending post-edit diagnostics
 * and append them as a trailing synthetic user message on the outgoing
 * view. Stale entries (a newer mutation landed since the fetch) are
 * dropped by the coordinator.
 */
export function transformMusepiLspContext<TMessage>(messages: TMessage[]): TMessage[] {
	if (!binding?.enabled) return messages;
	const entries = binding.coordinator.drain();
	if (entries.length === 0) return messages;
	return [
		...messages,
		{
			role: "user",
			content: [{ type: "text", text: renderDeferredDiagnostics(entries) }],
			timestamp: Date.now(),
		} as TMessage,
	];
}

// =============================================================================
// Tool definition + session init
// =============================================================================

const LSP_ACTIONS = ["diagnostics", "definition", "references", "hover", "symbols", "status"] as const;
type LspAction = (typeof LSP_ACTIONS)[number];

const LSP_DESCRIPTION = `Query language servers (LSP) for code intelligence. Servers start lazily on first use and are detected automatically (project root markers ∩ installed binaries).

Actions:
- diagnostics: diagnostics for a file (path) or everything published so far (no path). Sorted by severity, deduplicated.
- definition: go-to-definition. Requires path, line, column (1-based).
- references: all references of the symbol. Requires path, line, column (1-based).
- hover: type/documentation at a position. Requires path, line, column (1-based).
- symbols: document outline (classes, functions, …). Requires path.
- status: active and detected servers, their source and uptime.`;

interface LspParams {
	action: LspAction;
	path?: string;
	line?: number;
	column?: number;
}

export const musepiLspToolDef: ToolDefinition = {
	name: "lsp",
	label: "LSP",
	description: LSP_DESCRIPTION,
	promptSnippet: "Query language servers for diagnostics, definitions, references, hover and symbols",
	parameters: Type.Object({
		action: Type.Union(
			[
				Type.Literal("diagnostics"),
				Type.Literal("definition"),
				Type.Literal("references"),
				Type.Literal("hover"),
				Type.Literal("symbols"),
				Type.Literal("status"),
			],
			{ description: "Which LSP query to run" },
		),
		path: Type.Optional(Type.String({ description: "File path (workspace-relative or absolute)" })),
		line: Type.Optional(Type.Number({ description: "1-based line (definition/references/hover)" })),
		column: Type.Optional(Type.Number({ description: "1-based column (definition/references/hover)" })),
	}),
	async execute(_toolCallId: string, params: LspParams, signal?: AbortSignal) {
		if (!binding?.enabled) {
			return {
				content: [{ type: "text" as const, text: "LSP integration is disabled (musepi.lsp.enabled = false)." }],
				details: {},
			};
		}
		let text: string;
		switch (params.action) {
			case "diagnostics":
				text = await executeDiagnostics(params, signal);
				break;
			case "definition":
			case "references":
				text = await executeLocationAction(params.action, params, signal);
				break;
			case "hover":
				text = await executeHover(params, signal);
				break;
			case "symbols":
				text = await executeSymbols(params, signal);
				break;
			case "status":
				text = executeStatus();
				break;
		}
		return { content: [{ type: "text" as const, text }], details: {} };
	},
};

/**
 * Bind LSP for one session: resolve detected servers for the session cwd,
 * apply the idle timeout, and arm the post-mutation diagnostics listener.
 * Called once per session right after AgentSession construction.
 */
export function initMusepiLsp(session: AgentSession, settingsManager: SettingsManager): void {
	const config = settingsManager.getMusepi().lsp;
	const cwd = session.sessionManager.getCwd();
	binding?.detachMutationListener?.();
	binding = {
		enabled: config.enabled,
		cwd,
		servers: config.enabled ? resolveLspServers(cwd, config.servers) : {},
		registry: binding?.registry ?? new LspRegistryCtor(),
		coordinator: binding?.coordinator ?? new DeferredDiagnosticsCoordinator(),
		detachMutationListener: null,
	};
	binding.registry.setIdleTimeout(config.idleTimeoutMs);
	if (config.enabled) {
		binding.detachMutationListener = addFileMutationListener(notifyMusepiLspFileMutated);
	}
}
