import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { Icon } from "../vendor/oc-icons";
import { DialogFrame } from "./DialogFrame";

/**
 * Debug Tools panel (desktop adaptation of the TUI /debug selector).
 *
 * The TUI's /debug opens an interactive diagnostics menu (report bundles,
 * CPU/heap profiling, logs, system info, work-profile flamegraph, raw SSE,
 * remote inspector, transcript export, artifact cache). The GUI gets the
 * same actions via daemon debug.* RPCs and renders this panel instead —
 * triggered by typing /debug in the composer (same detection as /usage).
 * Terminal-bound entries (terminal state, protocol probe) have no GUI
 * equivalent and are shown disabled.
 */

interface DebugRpc {
	request<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const MENU = [
	{ id: "open-artifacts", label: "settings.debugOpenArtifacts", desc: "settings.debugOpenArtifactsDesc" },
	{ id: "performance", label: "settings.debugPerformance", desc: "settings.debugPerformanceDesc" },
	{ id: "work", label: "settings.debugWorkProfile", desc: "settings.debugWorkProfileDesc" },
	{ id: "dump", label: "settings.debugDumpSession", desc: "settings.debugDumpSessionDesc" },
	{ id: "memory", label: "settings.debugMemory", desc: "settings.debugMemoryDesc" },
	{ id: "logs", label: "settings.debugLogs", desc: "settings.debugLogsDesc" },
	{ id: "system", label: "settings.debugSystemInfo", desc: "settings.debugSystemInfoDesc" },
	{ id: "settings.terminal", label: "settings.debugTerminalState", desc: "settings.debugTerminalStateDesc", terminalOnly: true },
	{ id: "protocols", label: "settings.debugTerminalProtocols", desc: "settings.debugTerminalProtocolsDesc", terminalOnly: true },
	{ id: "raw-sse", label: "settings.debugRawSse", desc: "settings.debugRawSseDesc" },
	{ id: "remote-debugger", label: "settings.debugRemoteDebugger", desc: "settings.debugRemoteDebuggerDesc" },
	{ id: "transcript", label: "settings.debugTranscript", desc: "settings.debugTranscriptDesc" },
	{ id: "clear-cache", label: "settings.debugClearCache", desc: "settings.debugClearCacheDesc" },
] as const;

type MenuId = (typeof MENU)[number]["id"];

type DebugResult =
	| { kind: "text"; text: string }
	| { kind: "path"; path: string; files?: number; note?: string }
	| { kind: "svg"; svg: string; sampleCount: number }
	| { kind: "endpoint"; host: string; port: number; alreadyRunning: boolean }
	| { kind: "stats"; count: number; totalSize: number; oldestDate: number | null }
	| { kind: "error"; message: string };

function fmtBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

export function DebugToolsPanel({
	open,
	onClose,
	rpc,
	sessionId,
}: {
	open: boolean;
	onClose(): void;
	rpc: DebugRpc;
	sessionId: string;
}): ReactNode {
	return (
		<DialogFrame open={open} onClose={onClose} label={t("settings.debugTools")} className="w-[560px] max-w-[92vw]">
			<DebugToolsPanelBody open={open} onClose={onClose} rpc={rpc} sessionId={sessionId} />
		</DialogFrame>
	);
}

/**
 * Panel content, split from the DialogFrame shell so SSR tests can render it
 * without portals (React 19's server renderer rejects createPortal).
 */
export function DebugToolsPanelBody({
	open,
	onClose,
	rpc,
	sessionId,
}: {
	open: boolean;
	onClose(): void;
	rpc: DebugRpc;
	sessionId: string;
}): ReactNode {
	const [busy, setBusy] = useState<MenuId | null>(null);
	const [results, setResults] = useState<Partial<Record<MenuId, DebugResult>>>({});
	const [profiling, setProfiling] = useState<{ profilerId: number } | null>(null);
	const [cacheArmed, setCacheArmed] = useState(false);

	const setResult = (id: MenuId, result: DebugResult): void => {
		setResults(prev => (prev[id] === result ? prev : { ...prev, [id]: result }));
	};

	// Stop an in-flight profiler when the panel closes (TUI parity: Esc ends
	// the profile the same way — the daemon profiler must not leak).
	useEffect(() => {
		if (open) return;
		if (!profiling) return;
		const pid = profiling.profilerId;
		void rpc
			.request<{ path: string }>("debug.profileStop", { profilerId: pid, sessionId })
			.then(res => setResult("performance", { kind: "path", path: res.path }))
			.catch(() => {})
			.finally(() => setProfiling(null));
	}, [open, profiling, rpc, sessionId]);

	const run = async (id: MenuId): Promise<void> => {
		if (busy) return;
		setBusy(id);
		try {
			switch (id) {
				case "open-artifacts": {
					const res = await rpc.request<{ path: string | null; reason?: string }>("debug.openArtifacts", {
						sessionId,
					});
					if (res.path) setResult(id, { kind: "path", path: res.path });
					else
						setResult(id, {
							kind: "error",
							message: res.reason === "no-session-file" ? t("settings.debugNoSessionFile") : t("settings.debugNoArtifacts"),
						});
					break;
				}
				case "performance": {
					if (profiling) {
						const res = await rpc.request<{ path: string; files: string[]; summary?: string }>(
							"debug.profileStop",
							{ profilerId: profiling.profilerId, sessionId },
						);
						setProfiling(null);
						setResult(id, { kind: "path", path: res.path, files: res.files.length, note: res.summary });
					} else {
						const res = await rpc.request<{ profilerId: number }>("debug.profileStart");
						setProfiling({ profilerId: res.profilerId });
						setResult(id, { kind: "text", text: t("settings.debugProfiling") });
					}
					break;
				}
				case "work": {
					const res = await rpc.request<{ svg: string | null; sampleCount: number }>("debug.workProfile");
					if (!res.svg || res.sampleCount === 0) {
						setResult(id, { kind: "text", text: t("settings.debugNoWorkData") });
					} else {
						setResult(id, { kind: "svg", svg: res.svg, sampleCount: res.sampleCount });
					}
					break;
				}
				case "dump":
				case "memory": {
					const res = await rpc.request<{ path: string; files: string[] }>(
						id === "dump" ? "debug.dumpReport" : "debug.memoryReport",
						{ sessionId },
					);
					setResult(id, { kind: "path", path: res.path, files: res.files.length });
					break;
				}
				case "logs":
				case "system": {
					const res = await rpc.request<{ text: string }>(id === "logs" ? "debug.logs" : "debug.systemInfo");
					const empty = res.text.trim().length === 0;
					setResult(id, { kind: "text", text: empty ? t("settings.debugNoLogs") : res.text });
					break;
				}
				case "raw-sse": {
					const res = await rpc.request<{ text: string; totalEvents: number; droppedChars: number }>(
						"debug.rawSse",
						{ sessionId },
					);
					if (res.text.trim().length === 0) {
						setResult(id, { kind: "text", text: t("settings.debugNoRawSse") });
					} else {
						const dropped = res.droppedChars > 0 ? `\n\n[${t("settings.debugDroppedChars")}: ${res.droppedChars}]` : "";
						setResult(id, { kind: "text", text: `${res.text}${dropped}` });
					}
					break;
				}
				case "remote-debugger": {
					const res = await rpc.request<{ host: string; port: number; alreadyRunning: boolean }>(
						"debug.remoteDebugger",
					);
					setResult(id, { kind: "endpoint", host: res.host, port: res.port, alreadyRunning: res.alreadyRunning });
					break;
				}
				case "transcript": {
					const res = await rpc.request<{ path: string; chars: number }>("debug.transcript", { sessionId });
					setResult(id, { kind: "path", path: res.path });
					break;
				}
				case "clear-cache": {
					if (!cacheArmed) {
						const stats = await rpc.request<{ count: number; totalSize: number; oldestDate: number | null }>(
							"debug.cacheStats",
						);
						if (stats.count === 0) {
							setResult(id, { kind: "text", text: t("settings.debugCacheEmpty") });
							break;
						}
						setCacheArmed(true);
						setResult(id, { kind: "stats", ...stats });
					} else {
						const res = await rpc.request<{ removed: number }>("debug.clearCache");
						setCacheArmed(false);
						setResult(id, { kind: "text", text: t("settings.debugCleared", { count: res.removed }) });
					}
					break;
				}
				case "settings.terminal":
				case "protocols":
					break;
			}
		} catch (err) {
			setResult(id, { kind: "error", message: errMessage(err) });
		} finally {
			setBusy(null);
		}
	};

	return (
		<div className="gui-dbg-panel">
			<div className="gui-dbg-head">
				<span className="gui-dbg-title">{t("settings.debugTools")}</span>
				<button type="button" className="gui-dbg-close" onClick={onClose} aria-label={t("settings.close")}>
					<Icon name="close" className="h-3.5 w-3.5" />
				</button>
			</div>
			<div className="gui-dbg-list">
				{MENU.map(item => {
					const terminalOnly = (item as { terminalOnly?: boolean }).terminalOnly === true;
					const result = results[item.id];
					return (
						<div key={item.id} className="gui-dbg-row">
							<button
								type="button"
								className="gui-dbg-row-main"
								disabled={terminalOnly || busy !== null}
								onClick={() => void run(item.id)}
							>
								<span className="gui-dbg-row-label">
									{terminalOnly && <span className="gui-dbg-tag">{t("settings.debugTerminalOnly")}</span>}
									{t(item.label)}
									{busy === item.id && <span className="gui-dbg-busy" aria-hidden="true" />}
								</span>
								<span className="gui-dbg-row-desc">{t(item.desc)}</span>
							</button>
							{profiling && item.id === "performance" && (
								<button type="button" className="gui-dbg-row-action" onClick={() => void run("performance")}>
									{t("settings.debugStopProfiling")}
								</button>
							)}
							{cacheArmed && item.id === "clear-cache" && (
								<button
									type="button"
									className="gui-dbg-row-action gui-dbg-row-action--danger"
									onClick={() => void run("clear-cache")}
								>
									{t("settings.debugConfirmClear")}
								</button>
							)}
							{result && <DebugResultView result={result} />}
						</div>
					);
				})}
			</div>
		</div>
	);
}

function DebugResultView({ result }: { result: DebugResult }): ReactNode {
	switch (result.kind) {
		case "text":
			return <pre className="gui-dbg-pre">{result.text}</pre>;
		case "path":
			return (
				<div className="gui-dbg-path">
					<span className="gui-dbg-path-line" title={result.path}>
						{result.path}
					</span>
					{result.files !== undefined && (
						<span className="gui-dbg-path-meta">{t("settings.debugFiles", { count: result.files })}</span>
					)}
					{result.note && <pre className="gui-dbg-pre">{result.note}</pre>}
				</div>
			);
		case "svg":
			return (
				<div className="gui-dbg-svg">
					<img
						src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`}
						alt={t("settings.debugWorkProfile")}
					/>
					<span className="gui-dbg-path-meta">{t("settings.debugSamples", { count: result.sampleCount })}</span>
				</div>
			);
		case "endpoint":
			return (
				<div className="gui-dbg-path">
					<span className="gui-dbg-path-line">
						{t("settings.debugListening", { host: result.host, port: String(result.port) })}
						{result.alreadyRunning && <span className="gui-dbg-tag">{t("settings.debugAlreadyRunning")}</span>}
					</span>
					<span className="gui-dbg-path-meta">{t("settings.debugRemoteInspectorNote")}</span>
				</div>
			);
		case "stats":
			return (
				<div className="gui-dbg-path">
					<span className="gui-dbg-path-line">
						{t("settings.debugCacheStats", {
							count: String(result.count),
							size: fmtBytes(result.totalSize),
							date: result.oldestDate ? new Date(result.oldestDate).toLocaleDateString() : "—",
						})}
					</span>
				</div>
			);
		case "error":
			return <div className="gui-dbg-error">{result.message}</div>;
	}
}
