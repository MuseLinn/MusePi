import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";

/** File-index service status (daemon file-index RPC). */
interface IndexStatus {
	enabled: boolean;
	dir: string | null;
	files: number;
	lastScan: number | null;
	scanning: boolean;
	skipped: number;
	truncated: boolean;
}

interface IndexHit {
	path: string;
	snippet: string;
}

/** Settings → 数据与统计 → 索引库: Zed-style code-library index — workspace
 * file contents → daemon FTS5 → instant search. (History-session search
 * lives in its own 历史会话 tab now.) */
export function IndexesSection({ rpc, cwd }: { rpc: RpcClient | null; cwd?: string | null }): ReactNode {
	const [idxStatus, setIdxStatus] = useState<IndexStatus | null>(null);
	const [idxEnabled, setIdxEnabled] = useState(() => {
		try {
			return localStorage.getItem("musepi-gui-index-enabled") !== "0";
		} catch {
			return true;
		}
	});
	const [autoFolders, setAutoFolders] = useState(() => {
		try {
			return localStorage.getItem("musepi-gui-index-newfolders") !== "0";
		} catch {
			return true;
		}
	});
	const [idxQuery, setIdxQuery] = useState("");
	const [idxHits, setIdxHits] = useState<IndexHit[] | null>(null);
	const [idxSearching, setIdxSearching] = useState(false);

	// Status + (when enabled) background scan of the active workspace.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const tick = (): void => {
			void rpc
				.request<IndexStatus>("index.status")
				.then(st => {
					if (!alive) return;
					setIdxStatus(st);
					// Mirror the renderer's switch into the daemon (the DB
					// default is off; the switch reads localStorage).
					if (!st.enabled && idxEnabled) {
						void rpc.request("index.setEnabled", { enabled: true }).catch(() => {});
					}
					// Incremental scan — mtime/offset skip makes this cheap.
					// No session cwd? The daemon falls back to its launch dir.
					if (st.enabled && !st.scanning) {
						void rpc.request("index.scan", cwd ? { cwd } : {}).catch(() => {});
					}
				})
				.catch(() => alive && setIdxStatus(null));
		};
		tick();
		const id = setInterval(tick, 2000);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [rpc, cwd, idxEnabled]);

	// Instant code search (debounced).
	useEffect(() => {
		const q = idxQuery.trim();
		if (q.length < 2) {
			setIdxHits(null);
			return;
		}
		const id = setTimeout(() => {
			if (!rpc) return;
			setIdxSearching(true);
			void rpc
				.request<IndexHit[]>("index.search", { query: q, limit: 30 })
				.then(hits => setIdxHits(hits ?? []))
				.catch(() => setIdxHits([]))
				.finally(() => setIdxSearching(false));
		}, 250);
		return () => clearTimeout(id);
	}, [idxQuery, rpc]);

	const toggleIndex = (next: boolean): void => {
		setIdxEnabled(next);
		try {
			localStorage.setItem("musepi-gui-index-enabled", next ? "1" : "0");
		} catch {
			// ignore
		}
		tapFeedback();
		if (next && rpc) {
			void rpc.request("index.setEnabled", { enabled: true }).then(() => {
				if (cwd) void rpc.request("index.scan", { cwd }).catch(() => {});
			});
		} else {
			void rpc?.request("index.setEnabled", { enabled: false }).catch(() => {});
		}
	};

	const lastScanLabel = idxStatus?.lastScan ? new Date(idxStatus.lastScan).toLocaleTimeString() : "—";

	// Snippet highlight: the daemon wraps matches in \u0001..\u0002.
	const renderSnippet = (snip: string): ReactNode => {
		const parts = snip.split(/\u0001|\u0002/);
		return parts.map((part, i) => (i % 2 === 1 ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>));
	};

	return (
		<>
			<h2 className="gui-settings-page-title">{t("index library")}</h2>
			<p className="gui-settings-page-desc">{t("index library description")}</p>

			<div className="gui-settings-section-title">{t("code library")}</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("index new folders")}</div>
					<div className="gui-settings-row-desc">{t("index new folders description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={autoFolders}
					className={`gui-toggle${autoFolders ? " gui-toggle--on" : ""}`}
					onClick={() => {
						tapFeedback();
						setAutoFolders(v => {
							const next = !v;
							try {
								localStorage.setItem("musepi-gui-index-newfolders", next ? "1" : "0");
							} catch {
								// ignore
							}
							return next;
						});
					}}
				/>
			</div>
			<div className="gui-settings-row">
				<div>
					<div className="gui-settings-row-label">{t("index repositories")}</div>
					<div className="gui-settings-row-desc">{t("index repositories description")}</div>
				</div>
				<button
					type="button"
					role="switch"
					aria-checked={idxEnabled}
					className={`gui-toggle${idxEnabled ? " gui-toggle--on" : ""}`}
					onClick={() => toggleIndex(!idxEnabled)}
				/>
			</div>
			<div className="gui-settings-row text-[12px] text-[var(--color-text-muted)]">
				{idxStatus
					? idxStatus.scanning
						? `${t("indexing")}…`
						: `${t("indexed files")}: ${idxStatus.files} · ${t("last scan")}: ${lastScanLabel}${idxStatus.truncated ? ` · ${t("index truncated")}` : ""}`
					: t("index unavailable")}
			</div>
			<div className="gui-settings-row">
				<input
					type="search"
					className="gui-settings-input w-full"
					placeholder={t("instant search placeholder")}
					value={idxQuery}
					onChange={e => setIdxQuery(e.target.value)}
				/>
			</div>
			{idxSearching ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-faint)]">…</div>
			) : idxHits && idxHits.length === 0 ? (
				<div className="gui-settings-row text-[13px] text-[var(--color-text-muted)]">{t("no results")}</div>
			) : (
				(idxHits ?? []).map(h => (
					<div key={h.path} className="gui-agent-card">
						<div className="truncate font-mono text-[12px] text-[var(--color-text-muted)]">{h.path}</div>
						<div className="mt-0.5 line-clamp-2 text-[13px]">{renderSnippet(h.snippet)}</div>
					</div>
				))
			)}
		</>
	);
}
