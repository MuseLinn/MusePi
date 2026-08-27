import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { tapFeedback } from "../lib/haptic";
import type { RpcClient } from "../lib/rpc";
import { shortcutLabel } from "../lib/shortcuts";
import { useTwoPhaseEnter } from "../lib/use-two-phase-enter";
import { Icon } from "../vendor/oc-icons";
import { MENU_ANIM_MS } from "./Pop";

type PaletteTab = "all" | "actions" | "tasks";

interface SearchRow {
	sessionId: string;
	label: string;
	count: number;
	snippet: string;
}

/**
 * Command palette (ZCode/openchamber parity, ⌘K / sidebar 搜索): quick
 * actions (建议 + 面板) and cross-session message search (daemon
 * session.search), with arrow-key navigation and Enter to run. The 文件 tab
 * of the reference palette needs a daemon file-search RPC that does not
 * exist yet, so the tabs are 全部 / 操作 / 任务.
 */
export function CommandPalette({
	open,
	onClose,
	rpc,
	sessions,
	onNewSession,
	onOpenWorkspace,
	onSettings,
	onToggleSidebar,
	onToggleTerminal,
	onTogglePreview,
	onSelectSession,
	onOpenAgents,
}: {
	open: boolean;
	onClose(): void;
	rpc: RpcClient;
	/** Recent sessions (label lookup for search results). */
	sessions: { id: string; label: string }[];
	onNewSession(): void;
	onOpenWorkspace(): void;
	onSettings(): void;
	onToggleSidebar(): void;
	onToggleTerminal(): void;
	onTogglePreview(): void;
	onSelectSession(id: string): void;
	onOpenAgents(): void;
}): ReactNode {
	const [query, setQuery] = useState("");
	const [tab, setTab] = useState<PaletteTab>("all");
	const [rows, setRows] = useState<SearchRow[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [active, setActive] = useState(0);
	const listRef = useRef<HTMLDivElement | null>(null);
	const inputRef = useRef<HTMLInputElement | null>(null);
	// Stay mounted through the exit (Pop/DialogFrame parity): the parent
	// renders us unconditionally and drives `open`; closing plays
	// gui-menu-out before unmounting. Two-phase enter via the hook.
	const [visible, setVisible] = useState(open);
	const [closing, setClosing] = useState(false);
	const enteredCls = useTwoPhaseEnter(open);
	useEffect(() => {
		if (open) {
			setVisible(true);
			setClosing(false);
			return;
		}
		setClosing(true);
		const t = setTimeout(() => {
			setVisible(false);
			setClosing(false);
		}, MENU_ANIM_MS);
		return () => clearTimeout(t);
	}, [open]);

	// Cross-session message search (debounced), like the daemon's search.
	useEffect(() => {
		if (open) {
			setActive(0);
			const q = query.trim();
			if (!q) {
				setRows(null);
				setSearching(false);
				return;
			}
			setSearching(true);
			const id = setTimeout(() => {
				void rpc
					.request<{
						matches: { sessionId: string; content: string; timestamp: string }[];
						sessions: { sessionId: string; messageCount: number }[];
					}>("session.search", { query: q, limit: 40 })
					.then(res => {
						const counts = new Map((res?.sessions ?? []).map(s => [s.sessionId, s.messageCount]));
						const labelOf = (id: string): string =>
							sessions.find(s => s.id === id)?.label ?? t("untitled session");
						const seen = new Map<string, SearchRow>();
						for (const m of res?.matches ?? []) {
							if (!seen.has(m.sessionId)) {
								seen.set(m.sessionId, {
									sessionId: m.sessionId,
									label: labelOf(m.sessionId),
									count: counts.get(m.sessionId) ?? 1,
									snippet: m.content.trim().slice(0, 90),
								});
							}
						}
						setRows([...seen.values()].slice(0, 12));
						setSearching(false);
					})
					.catch(() => {
						setRows([]);
						setSearching(false);
					});
			}, 250);
			return () => clearTimeout(id);
		}
		// Closed: defer the reset until the exit animation finished so the
		// list doesn't collapse mid-fade.
		if (!visible) {
			setQuery("");
			setRows(null);
		}
		return;
	}, [query, open, visible, rpc, sessions]);

	useEffect(() => {
		if (!open) return;
		inputRef.current?.focus();
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") {
				onClose();
			} else if (e.key === "ArrowDown") {
				e.preventDefault();
				setActive(n => n + 1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				setActive(n => Math.max(0, n - 1));
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	const run = (fn: () => void): void => {
		tapFeedback();
		fn();
		onClose();
	};

	// Flat item list for keyboard navigation: [actions…, tasks…].
	const actions: { icon: string; label: string; hint?: string; fn(): void }[] = [
		{ icon: "add-circle", label: t("new task"), hint: "⌘N", fn: onNewSession },
		{ icon: "folder-open", label: t("open workspace"), hint: "⌘O", fn: onOpenWorkspace },
		{ icon: "settings-3", label: t("settings"), fn: onSettings },
	];
	const panels: { icon: string; label: string; hint?: string; fn(): void }[] = [
		{ icon: "layout-left", label: t("toggle sidebar"), hint: "⌘B", fn: onToggleSidebar },
		{ icon: "terminal-box", label: t("toggle terminal"), hint: "⌘J", fn: onToggleTerminal },
		{ icon: "equalizer-2", label: t("toggle preview"), hint: "⌘E", fn: onTogglePreview },
		{ icon: "ai-agent-fill", label: t("agents center"), fn: onOpenAgents },
	];
	const taskRows = (rows ?? sessions.slice(0, 8)).map<{
		icon: string;
		label: string;
		hint?: string;
		snippet?: string;
		fn(): void;
	}>(s => ({
		icon: "chat-1",
		label: s.label || t("untitled session"),
		hint: "count" in s ? String(s.count) : undefined,
		snippet: "snippet" in s ? s.snippet : undefined,
		fn: (): void => onSelectSession("sessionId" in s ? s.sessionId : s.id),
	}));
	const showTasks = tab !== "actions";
	const showActions = tab !== "tasks";
	const items = [...(showActions ? actions : []), ...(showActions ? panels : []), ...(showTasks ? taskRows : [])];
	useEffect(() => {
		listRef.current
			?.querySelector<HTMLElement>(`[data-palette-row="${active}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [active]);

	if (!visible) return null;
	return createPortal(
		<div className={`gui-palette-backdrop${closing ? " gui-palette-backdrop--closing" : ""}`} onClick={onClose}>
			<div
				className={`gui-palette${enteredCls ? " gui-palette--entered" : ""}${closing ? " gui-palette--closing" : ""}`}
				role="dialog"
				aria-modal="true"
				aria-label={t("search")}
				onClick={e => e.stopPropagation()}
				onKeyDown={e => {
					if (e.key === "Enter") {
						const item = items[active];
						if (item) run(item.fn);
					}
				}}
			>
				<div className="gui-palette-search">
					<Icon name="search" className="h-4 w-4 flex-shrink-0 text-[var(--color-text-faint)]" />
					<input
						ref={inputRef}
						value={query}
						onChange={e => setQuery(e.target.value)}
						placeholder={t("search actions, tasks or messages")}
						spellCheck={false}
						autoComplete="off"
					/>
				</div>
				<div className="gui-palette-tabs">
					{(["all", "actions", "tasks"] as PaletteTab[]).map(id => (
						<button
							key={id}
							type="button"
							className={`gui-palette-tab${tab === id ? " gui-palette-tab--active" : ""}`}
							onClick={() => {
								setTab(id);
								setActive(0);
							}}
						>
							<Icon
								name={id === "all" ? "menu-2" : id === "actions" ? "rocket" : "list-check-2"}
								className="h-3.5 w-3.5"
							/>
							<span>{id === "all" ? t("all") : id === "actions" ? t("actions") : t("tasks")}</span>
						</button>
					))}
				</div>
				<div className="gui-palette-body" key={tab} ref={listRef}>
					{showActions && (
						<div className="gui-palette-section">
							<div className="gui-palette-section-title">{t("suggestions")}</div>
							{actions.map((a, i) => (
								<button
									key={a.label}
									type="button"
									data-palette-row={i}
									className={`gui-palette-row${active === i ? " gui-palette-row--active" : ""}`}
									onMouseEnter={() => setActive(i)}
									onClick={() => run(a.fn)}
								>
									<Icon name={a.icon as never} className="h-4 w-4" />
									<span className="min-w-0 flex-1 truncate text-left">{a.label}</span>
									{a.hint && <span className="gui-palette-kbd">{shortcutLabel(a.hint)}</span>}
								</button>
							))}
						</div>
					)}
					{showActions && (
						<div className="gui-palette-section">
							<div className="gui-palette-section-title">{t("panels")}</div>
							{panels.map((p, i) => {
								const idx = actions.length + i;
								return (
									<button
										key={p.label}
										type="button"
										data-palette-row={idx}
										className={`gui-palette-row${active === idx ? " gui-palette-row--active" : ""}`}
										onMouseEnter={() => setActive(idx)}
										onClick={() => run(p.fn)}
									>
										<Icon name={p.icon as never} className="h-4 w-4" />
										<span className="min-w-0 flex-1 truncate text-left">{p.label}</span>
										{p.hint && <span className="gui-palette-kbd">{shortcutLabel(p.hint)}</span>}
									</button>
								);
							})}
						</div>
					)}
					{showTasks && (
						<div className="gui-palette-section">
							<div className="gui-palette-section-title">{query.trim() ? t("tasks") : t("recent sessions")}</div>
							{searching ? (
								<div className="gui-palette-empty">…</div>
							) : query.trim() && rows !== null && rows.length === 0 ? (
								<div className="gui-palette-empty">{t("no results")}</div>
							) : (
								taskRows.map((r, i) => {
									const idx = actions.length + panels.length + i;
									return (
										<button
											key={r.label + idx}
											type="button"
											data-palette-row={idx}
											className={`gui-palette-row${active === idx ? " gui-palette-row--active" : ""}`}
											onMouseEnter={() => setActive(idx)}
											onClick={() => run(r.fn)}
										>
											<Icon name={r.icon as never} className="h-4 w-4 flex-shrink-0" />
											<span className="min-w-0 flex-1">
												<span className="block truncate text-left">{r.label}</span>
												{r.snippet && (
													<span className="block truncate text-left text-[11.5px] text-[var(--color-text-faint)]">
														{r.snippet}
													</span>
												)}
											</span>
											{r.hint && <span className="gui-palette-kbd">{shortcutLabel(r.hint)}</span>}
										</button>
									);
								})
							)}
						</div>
					)}
				</div>
				<div className="gui-palette-footer">
					<button type="button" className="gui-palette-config" onClick={() => run(onSettings)}>
						<Icon name="settings-3" className="h-3.5 w-3.5" />
						<span>{t("configure")}</span>
					</button>
				</div>
			</div>
		</div>,
		/* Inside the React root (not body) so delegated listeners fire. */
		document.getElementById("root") ?? document.body,
	);
}
