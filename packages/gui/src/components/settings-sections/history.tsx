import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import { tapFeedback } from "../../lib/haptic";
import type { RpcClient } from "../../lib/rpc";
import { Icon } from "../../vendor/oc-icons";
import type { SearchHit, SearchResult } from "./shared";
import { hitText } from "./shared";

/** One row from daemon session.list (history viewer left pane). */
interface SessionRow {
	id: string;
	title?: string;
	timestamp?: string;
	messageCount?: number;
	model?: string;
	cwd?: string;
}

/** Settings → 数据与统计 → 历史会话: two-pane history browser (like the
 * extensions center) — session list left, message stream right; the search
 * box filters sessions to those containing a message match and the right
 * pane shows the hits. */
export function HistorySection({
	rpc,
	onOpenSession,
}: {
	rpc: RpcClient | null;
	onOpenSession?: (sessionId: string) => void;
}): ReactNode {
	const [sessions, setSessions] = useState<SessionRow[] | null>(null);
	const [query, setQuery] = useState("");
	const [searchRes, setSearchRes] = useState<SearchResult | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [messages, setMessages] = useState<SearchHit[] | null>(null);
	const [loadingMsgs, setLoadingMsgs] = useState(false);
	// Cross-session message-search in-flight flag (the debounced search
	// effect below sets it; was referenced without a declaration).
	const [searching, setSearching] = useState(false);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<SessionRow[]>("session.list", {})
			.then(rows => {
				if (!alive) return;
				setSessions(rows ?? []);
				// Preselect the most recent session WITH messages when
				// nothing is open yet (fresh/empty sessions have no
				// materialized rows and would show an empty right pane).
				setSelected(prev => prev ?? rows?.find(r => (r.messageCount ?? 0) > 0)?.id ?? rows?.[0]?.id ?? null);
			})
			.catch(() => alive && setSessions([]));
		return () => {
			alive = false;
		};
	}, [rpc]);

	// Cross-session message search (debounced).
	useEffect(() => {
		const q = query.trim();
		if (q.length < 2) {
			setSearchRes(null);
			return;
		}
		const id = setTimeout(() => {
			if (!rpc) return;
			setSearching(true);
			void rpc
				.request<SearchResult>("session.search", { query: q, limit: 200 })
				.then(res => setSearchRes(res ?? null))
				.catch(() => setSearchRes(null))
				.finally(() => setSearching(false));
		}, 300);
		return () => clearTimeout(id);
	}, [query, rpc]);

	// Selected session's message stream.
	useEffect(() => {
		if (!selected || !rpc) {
			setMessages(null);
			return;
		}
		let alive = true;
		setLoadingMsgs(true);
		void rpc
			.request<SearchHit[]>("history.messages", { sessionId: selected, limit: 500 })
			.then(rows => {
				if (!alive) return;
				setMessages(rows ?? []);
				// Some sessions have a journal/messageCount but no rows in
				// the materialized messages table — hop to the next session
				// that does (once; never loop on an all-empty list).
				if ((!rows || rows.length === 0) && !searchRes) {
					const all = sessions ?? [];
					const idx = all.findIndex(s => s.id === selected);
					const next = all.slice(idx + 1).find(s => (s.messageCount ?? 0) > 0);
					if (next) setSelected(next.id);
				}
			})
			.catch(() => alive && setMessages([]))
			.finally(() => alive && setLoadingMsgs(false));
		return () => {
			alive = false;
		};
	}, [selected, rpc, searchRes, sessions]);

	const bySession = new Map<string, SearchHit[]>();
	for (const m of searchRes?.matches ?? []) {
		const list = bySession.get(m.sessionId) ?? [];
		list.push(m);
		bySession.set(m.sessionId, list);
	}
	// Searching: only sessions with hits (plus the selected one so the right
	// pane keeps a stable anchor). Not searching: the full list.
	const visibleSessions = searchRes
		? (sessions ?? []).filter(s => bySession.has(s.id) || s.id === selected)
		: (sessions ?? []);
	// Search hits land on a session with matches (jump off a stale pick).
	useEffect(() => {
		if (searchRes && selected && !bySession.has(selected) && bySession.size > 0) {
			setSelected([...bySession.keys()][0] ?? null);
		}
	}, [searchRes, selected, bySession]);
	const visibleMsgs = selected ? (searchRes ? (bySession.get(selected) ?? []) : (messages ?? [])) : [];

	return (
		<>
			<h2 className="gui-settings-page-title">{t("session history")}</h2>
			<p className="gui-settings-page-desc">{t("session history description")}</p>
			<div className="gui-ext-body" style={{ gridTemplateColumns: "minmax(0, 34%) minmax(0, 1fr)" }}>
				<div className="gui-ext-list">
					<div className="gui-ext-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
						<input
							type="search"
							className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
							placeholder={t("search messages placeholder")}
							value={query}
							onChange={e => setQuery(e.target.value)}
						/>
					</div>
					<div className="gui-ext-list-scroll">
						{sessions === null ? (
							<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-faint)]">…</div>
						) : visibleSessions.length === 0 ? (
							<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-muted)]">{t("no results")}</div>
						) : (
							visibleSessions.map(s => (
								<button
									key={s.id}
									type="button"
									className={`gui-history-item${selected === s.id ? " gui-history-item--active" : ""}`}
									onClick={() => {
										tapFeedback();
										setSelected(s.id);
									}}
								>
									<div className="truncate text-[12.5px] font-medium" title={s.title || s.id}>
										{s.title || s.id.slice(0, 10)}
									</div>
									<div className="truncate text-[11px] text-[var(--color-text-muted)]">
										{s.timestamp ? new Date(s.timestamp).toLocaleString() : ""}
										{s.messageCount != null ? ` · ${s.messageCount} ${t("messages")}` : ""}
										{searchRes ? ` · ${bySession.get(s.id)?.length ?? 0}` : ""}
									</div>
								</button>
							))
						)}
					</div>
				</div>
				<div className="gui-ext-list">
					<div className="gui-ext-search flex items-center justify-between gap-2">
						<span
							className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
							title={sessions?.find(s => s.id === selected)?.title || selected || ""}
						>
							{sessions?.find(s => s.id === selected)?.title || selected?.slice(0, 10) || "—"}
						</span>
						{selected && onOpenSession && (
							<button
								type="button"
								className="gui-btn gui-btn--small shrink-0"
								onClick={() => {
									tapFeedback();
									onOpenSession(selected);
								}}
							>
								{t("open")}
							</button>
						)}
					</div>
					<div className="gui-ext-list-scroll">
						<div key={selected ?? "none"} className="gui-history-swap">
							{loadingMsgs ? (
								<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-faint)]">…</div>
							) : visibleMsgs.length === 0 ? (
								<div className="px-2 py-3 text-[12.5px] text-[var(--color-text-muted)]">
									{searchRes ? t("no results") : t("no messages")}
								</div>
							) : (
								visibleMsgs.map(m => (
									<div key={`${m.sessionId}:${m.seq}`} className="gui-history-msg">
										<div className="flex items-center gap-2">
											<span className={`gui-history-role gui-history-role--${m.role}`}>{m.role}</span>
											<span className="text-[11px] text-[var(--color-text-faint)]">
												{new Date(m.timestamp).toLocaleTimeString()}
											</span>
											{m.model && (
												<span className="truncate font-mono text-[11px] text-[var(--color-text-faint)]">
													{m.model}
												</span>
											)}
										</div>
										<div className="mt-1 whitespace-pre-wrap break-words text-[12.5px] leading-relaxed">
											{hitText(m.content)}
										</div>
									</div>
								))
							)}
						</div>
					</div>
				</div>
			</div>
		</>
	);
}
