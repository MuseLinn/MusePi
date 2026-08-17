import { t } from "@musepi/desktop-web";
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
	{ id: "open-artifacts", label: "debug open artifacts", desc: "debug open artifacts desc" },
	{ id: "performance", label: "debug performance", desc: "debug performance desc" },
	{ id: "work", label: "debug work profile", desc: "debug work profile desc" },
	{ id: "dump", label: "debug dump session", desc: "debug dump session desc" },
	{ id: "memory", label: "debug memory", desc: "debug memory desc" },
	{ id: "logs", label: "debug logs", desc: "debug logs desc" },
	{ id: "system", label: "debug system info", desc: "debug system info desc" },
	{ id: "terminal", label: "debug terminal state", desc: "debug terminal state desc", terminalOnly: true },
	{ id: "protocols", label: "debug terminal protocols", desc: "debug terminal protocols desc", terminalOnly: true },
	{ id: "raw-sse", label: "debug raw sse", desc: "debug raw sse desc" },
	{ id: "remote-debugger", label: "debug remote debugger", desc: "debug remote debugger desc" },
	{ id: "transcript", label: "debug transcript", desc: "debug transcript desc" },
	{ id: "clear-cache", label: "debug clear cache", desc: "debug clear cache desc" },
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
		<DialogFrame open={open} onClose={onClose} label={t("debug tools")} className="w-[560px] max-w-[92vw]">
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
							message: res.reason === "no-session-file" ? t("debug no session file") : t("debug no artifacts"),
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
						setResult(id, { kind: "text", text: t("debug profiling") });
					}
					break;
				}
				case "work": {
					const res = await rpc.request<{ svg: string | null; sampleCount: number }>("debug.workProfile");
					if (!res.svg || res.sampleCount === 0) {
						setResult(id, { kind: "text", text: t("debug no work data") });
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
					setResult(id, { kind: "text", text: empty ? t("debug no logs") : res.text });
					break;
				}
				case "raw-sse": {
					const res = await rpc.request<{ text: string; totalEvents: number; droppedChars: number }>(
						"debug.rawSse",
						{ sessionId },
					);
					if (res.text.trim().length === 0) {
						setResult(id, { kind: "text", text: t("debug no raw sse") });
					} else {
						const dropped = res.droppedChars > 0 ? `\n\n[${t("debug dropped chars")}: ${res.droppedChars}]` : "";
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
							setResult(id, { kind: "text", text: t("debug cache empty") });
							break;
						}
						setCacheArmed(true);
						setResult(id, { kind: "stats", ...stats });
					} else {
						const res = await rpc.request<{ removed: number }>("debug.clearCache");
						setCacheArmed(false);
						setResult(id, { kind: "text", text: t("debug cleared", { count: res.removed }) });
					}
					break;
				}
				case "terminal":
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
				<span className="gui-dbg-title">{t("debug tools")}</span>
				<button type="button" className="gui-dbg-close" onClick={onClose} aria-label={t("close")}>
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
									{terminalOnly && <span className="gui-dbg-tag">{t("debug terminal only")}</span>}
									{t(item.label)}
									{busy === item.id && <span className="gui-dbg-busy" aria-hidden="true" />}
								</span>
								<span className="gui-dbg-row-desc">{t(item.desc)}</span>
							</button>
							{profiling && item.id === "performance" && (
								<button type="button" className="gui-dbg-row-action" onClick={() => void run("performance")}>
									{t("debug stop profiling")}
								</button>
							)}
							{cacheArmed && item.id === "clear-cache" && (
								<button
									type="button"
									className="gui-dbg-row-action gui-dbg-row-action--danger"
									onClick={() => void run("clear-cache")}
								>
									{t("debug confirm clear")}
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
						<span className="gui-dbg-path-meta">{t("debug files", { count: result.files })}</span>
					)}
					{result.note && <pre className="gui-dbg-pre">{result.note}</pre>}
				</div>
			);
		case "svg":
			return (
				<div className="gui-dbg-svg">
					<img
						src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(result.svg)}`}
						alt={t("debug work profile")}
					/>
					<span className="gui-dbg-path-meta">{t("debug samples", { count: result.sampleCount })}</span>
				</div>
			);
		case "endpoint":
			return (
				<div className="gui-dbg-path">
					<span className="gui-dbg-path-line">
						{t("debug listening", { host: result.host, port: String(result.port) })}
						{result.alreadyRunning && <span className="gui-dbg-tag">{t("debug already running")}</span>}
					</span>
					<span className="gui-dbg-path-meta">{t("debug remote inspector note")}</span>
				</div>
			);
		case "stats":
			return (
				<div className="gui-dbg-path">
					<span className="gui-dbg-path-line">
						{t("debug cache stats", {
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
