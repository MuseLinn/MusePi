import { type TranslationKey, t } from "@musepi/desktop-web";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { HeightMorph } from "./HeightMorph";

/**
 * 扩展控制中心 (extension control center) — TUI /extensions parity in the
 * GUI: one unified inventory over all 10 capability kinds
 * (extension-module / skill / rule / tool / mcp / prompt / instruction /
 * context-file / hook / slash-command), three states (active / disabled /
 * shadowed), provider tabs + provider→kind→item tree + detail pane with
 * raw inspector. Data + mutations come from the daemon extensions.* RPCs,
 * which share the TUI's normalization and persistence (disabledExtensions
 * ids, mcp.json denylist for mcp:, disabledProviders).
 */
export interface ExtensionItem {
	id: string;
	kind: string;
	name: string;
	displayName: string;
	description?: string;
	trigger?: string;
	path: string;
	source: { provider: string; providerName: string; level: "user" | "project" | "native" };
	state: "active" | "disabled" | "shadowed";
	disabledReason?: "provider-disabled" | "item-disabled" | "shadowed";
	shadowedBy?: string;
}

export interface ExtensionTab {
	id: string;
	label: string;
	enabled: boolean;
	count: number;
}

export interface ProviderInfo {
	id: string;
	displayName: string;
	enabled: boolean;
}

function kindLabel(kind: string): string {
	const key = `ext kind ${kind}`;
	const zh = t(key as TranslationKey);
	return zh === key ? kind : zh;
}

function stateLabel(e: ExtensionItem): string {
	if (e.state === "active") return t("extension active");
	if (e.state === "shadowed") return t("ext shadowed");
	return e.disabledReason === "provider-disabled" ? t("ext provider disabled") : t("ext item disabled");
}

function levelLabel(s: ExtensionItem): string {
	if (
		s.source.provider === "native" ||
		s.source.provider === "omp-managed" ||
		s.source.provider === "builtin-defaults"
	) {
		return t("skill filter builtin");
	}
	return s.source.level === "project" ? t("skill filter project") : t("skill filter user");
}

/** User-owned skills (user-level files, not native/auto-learn) can be
 *  deleted — mirrors the daemon's skills.delete guard. */
function isDeletable(e: ExtensionItem): boolean {
	return (
		e.kind === "skill" &&
		e.source.level === "user" &&
		e.source.provider !== "native" &&
		e.source.provider !== "omp-managed"
	);
}

/** GUI-only capability kinds (visual extensions with no TUI-side effect):
 *  motion packs + the built-in style. Tagged with a badge in the list and
 *  the detail pane so users can tell GUI-surface extensions apart. */
function isGuiKind(e: ExtensionItem): boolean {
	return e.kind === "gui-motion" || e.kind === "style";
}

export function ExtensionsCenter({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [extensions, setExtensions] = useState<ExtensionItem[] | null>(null);
	const [tabs, setTabs] = useState<ExtensionTab[]>([]);
	const [providers, setProviders] = useState<ProviderInfo[]>([]);
	const [error, setError] = useState<string | null>(null);
	const [tab, setTab] = useState("all");
	const [query, setQuery] = useState("");
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const [detail, setDetail] = useState<{ content: string; filePath: string } | null>(null);
	const [raw, setRaw] = useState<string | null>(null);
	const [rawOpen, setRawOpen] = useState(false);
	const [collapsedKinds, setCollapsedKinds] = useState<Set<string>>(new Set());
	const { confirm } = useConfirm();

	// Poll the unified inventory (5s, same rhythm as the old skills list).
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		const load = (): void => {
			if (document.visibilityState === "hidden" || !alive) return;
			void rpc
				.request<{ extensions: ExtensionItem[]; tabs: ExtensionTab[]; providers: ProviderInfo[] } | null>(
					"extensions.list",
					{},
				)
				.then(res => {
					if (!alive) return;
					setExtensions(res?.extensions ?? []);
					setTabs(res?.tabs ?? []);
					setProviders(res?.providers ?? []);
				})
				.catch(() => alive && setExtensions(prev => prev ?? []));
		};
		load();
		const id = setInterval(load, 5000);
		// HMR: the daemon watcher pushes extensions.changed — refresh the
		// inventory immediately instead of waiting up to 5s for the poll.
		const off = rpc.addEventListener(event => {
			const payload = event.payload as { type?: string } | undefined;
			if (payload?.type === "extensions.changed") load();
		});
		return () => {
			alive = false;
			clearInterval(id);
			off();
		};
	}, [rpc]);

	const selected = useMemo(() => (extensions ?? []).find(e => e.id === selectedId) ?? null, [extensions, selectedId]);

	// Detail content (lazy): skills → SKILL.md via skills.read; context
	// files → fs.read; other kinds have no content file (inspector only).
	useEffect(() => {
		if (!selected || !rpc) {
			setDetail(null);
			return;
		}
		let alive = true;
		setDetail(null);
		setRaw(null);
		setRawOpen(false);
		if (selected.kind === "skill") {
			void rpc
				.request<{ content: string; filePath: string }>("skills.read", { name: selected.name })
				.then(res => {
					if (!alive) return;
					setDetail(res ? { content: res.content, filePath: res.filePath } : null);
				})
				.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		} else if (selected.kind === "context-file") {
			void rpc
				.request<{ content: string | null }>("fs.read", { path: selected.path })
				.then(res => {
					if (!alive) return;
					setDetail(res?.content ? { content: res.content, filePath: selected.path } : null);
				})
				.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		}
		return () => {
			alive = false;
		};
	}, [selected, rpc]);

	const loadRaw = (): void => {
		if (!selected || !rpc) return;
		setRawOpen(true);
		if (raw !== null) return;
		void rpc
			.request<{ raw: string }>("extensions.raw", { id: selected.id })
			.then(res => setRaw(res?.raw ?? "{}"))
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	};

	const toggle = (e: ExtensionItem, next: boolean): void => {
		if (!rpc) return;
		const prevState = e.state;
		setExtensions(
			prevList =>
				prevList?.map(x =>
					x.id === e.id
						? {
								...x,
								state: next ? "active" : ("disabled" as const),
								disabledReason: next ? undefined : ("item-disabled" as const),
							}
						: x,
				) ?? null,
		);
		void rpc
			.request("extensions.setEnabled", { id: e.id, enabled: next })
			.then(() => setError(null))
			.catch((err: unknown) => {
				setExtensions(prevList => prevList?.map(x => (x.id === e.id ? { ...x, state: prevState } : x)) ?? null);
				setError(err instanceof Error ? err.message : String(err));
			});
	};

	const toggleProvider = (p: ProviderInfo): void => {
		if (!rpc) return;
		const prev = p.enabled;
		setProviders(list => list.map(x => (x.id === p.id ? { ...x, enabled: !prev } : x)));
		void rpc
			.request("extensions.setProviderEnabled", { providerId: p.id, enabled: !prev })
			.then(() => setError(null))
			.catch((err: unknown) => {
				setProviders(list => list.map(x => (x.id === p.id ? { ...x, enabled: prev } : x)));
				setError(err instanceof Error ? err.message : String(err));
			});
	};

	const remove = (e: ExtensionItem): void => {
		if (!rpc) return;
		void confirm(t("delete skill confirm {name}", { name: e.name }), t("delete")).then(ok => {
			if (!ok) return;
			void rpc
				.request("skills.delete", { name: e.name })
				.then(() => {
					setExtensions(prevList => prevList?.filter(x => x.id !== e.id) ?? null);
					if (selectedId === e.id) setSelectedId(null);
				})
				.catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
		});
	};

	// Search filter (name/description/trigger/provider/kind) + tab filter.
	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		return (extensions ?? []).filter(e => {
			if (tab !== "all" && e.source.provider !== tab) return false;
			if (!q) return true;
			return [e.name, e.displayName, e.description ?? "", e.trigger ?? "", e.source.providerName, e.kind]
				.join(" ")
				.toLowerCase()
				.includes(q);
		});
	}, [extensions, tab, query]);

	// Tree: non-native providers (with kind groups) + a read-only 内置 node
	// for native items so builtins stay reachable (TUI tabs skip native).
	const tree = useMemo(() => {
		const nodes: {
			provider: ProviderInfo;
			count: number;
			enabled: boolean;
			kinds: { kind: string; count: number; items: ExtensionItem[] }[];
		}[] = [];
		const nativeItems: ExtensionItem[] = [];
		for (const p of providers) {
			const items = filtered.filter(e => e.source.provider === p.id);
			if (p.id === "native") {
				nativeItems.push(...items);
				continue;
			}
			if (items.length === 0 && !p.enabled) continue; // empty disabled providers stay hidden
			const kinds = new Map<string, ExtensionItem[]>();
			for (const it of items) {
				const list = kinds.get(it.kind) ?? [];
				list.push(it);
				kinds.set(it.kind, list);
			}
			nodes.push({
				provider: p,
				count: items.length,
				enabled: p.enabled,
				kinds: [...kinds.entries()]
					.map(([kind, list]) => ({ kind, count: list.length, items: list }))
					.sort((a, b) => b.count - a.count),
			});
		}
		nodes.sort((a, b) => (a.count === 0 ? 1 : 0) - (b.count === 0 ? 1 : 0) || b.count - a.count);
		return { nodes, nativeItems };
	}, [providers, filtered]);

	const toggleKind = (key: string): void => {
		setCollapsedKinds(prev => {
			const next = new Set(prev);
			if (next.has(key)) next.delete(key);
			else next.add(key);
			return next;
		});
	};

	return (
		<div className="gui-ext-center">
			{/* Top tabs: ALL + provider tabs (TUI buildProviderTabs order).
			 * Disabled providers render greyed but stay clickable. */}
			<div className="gui-ext-tabs" role="tablist">
				<button
					type="button"
					role="tab"
					aria-selected={tab === "all"}
					className={`gui-ext-tab${tab === "all" ? " gui-ext-tab--active" : ""}`}
					onClick={() => setTab("all")}
				>
					ALL
					<span className="gui-ext-tab-count">{(extensions ?? []).length}</span>
				</button>
				{tabs
					.filter(t => t.id !== "all")
					.map(tr => (
						<button
							key={tr.id}
							type="button"
							role="tab"
							aria-selected={tab === tr.id}
							className={`gui-ext-tab${tab === tr.id ? " gui-ext-tab--active" : ""}${tr.enabled ? "" : " gui-ext-tab--off"}`}
							onClick={() => setTab(tr.id)}
						>
							{tr.label}
							<span className="gui-ext-tab-count">{tr.count}</span>
						</button>
					))}
			</div>
			{error && <div className="px-1 pb-1 text-[12.5px] text-[var(--color-warning)]">{error}</div>}
			<div className="gui-ext-body">
				{/* Left: search + provider→kind→item tree. */}
				<div className="gui-ext-list">
					<div className="gui-ext-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
						<input
							className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
							placeholder={t("search skills...")}
							value={query}
							onChange={e => setQuery(e.target.value)}
						/>
					</div>
					<div className="gui-ext-list-scroll">
						{tree.nodes.map(node => {
							const providerKey = `p:${node.provider.id}`;
							const providerCollapsed = collapsedKinds.has(providerKey);
							return (
								<div key={node.provider.id} className="gui-ext-provider">
									<div
										className="gui-ext-provider-h"
										role="button"
										tabIndex={0}
										onClick={() => toggleKind(providerKey)}
									>
										<Icon
											name={providerCollapsed ? "arrow-right-s" : "arrow-down-s"}
											className="h-3.5 w-3.5 shrink-0 opacity-60"
										/>
										<span className={`gui-ext-dot${node.enabled ? "" : " gui-ext-dot--off"}`} />
										<span className="min-w-0 flex-1 truncate text-[12px] font-medium">
											{node.provider.displayName}
										</span>
										<span className="gui-ext-group-count">({node.count})</span>
										{node.provider.id !== "native" && (
											<button
												type="button"
												role="switch"
												aria-checked={node.enabled}
												aria-label={`${t("ext provider")} ${node.provider.displayName}`}
												className={`gui-toggle gui-toggle--sm${node.enabled ? " gui-toggle--on" : ""}`}
												onClick={e => {
													e.stopPropagation();
													toggleProvider(node.provider);
												}}
											>
												<span className="gui-toggle-knob" />
											</button>
										)}
									</div>
									{!providerCollapsed && (
										<div className="gui-ext-provider-children">
											{node.kinds.map(k => {
												const kindKey = `${node.provider.id}:${k.kind}`;
												const kindCollapsed = collapsedKinds.has(kindKey);
												return (
													<div key={kindKey}>
														<div
															className="gui-ext-kind-h"
															role="button"
															tabIndex={0}
															onClick={() => toggleKind(kindKey)}
														>
															<Icon
																name={kindCollapsed ? "arrow-right-s" : "arrow-down-s"}
																className="h-3 w-3 shrink-0 opacity-50"
															/>
															<span className="min-w-0 flex-1 truncate text-[11.5px]">
																{kindLabel(k.kind)}
															</span>
															<span className="gui-ext-group-count">{k.count}</span>
														</div>
														{!kindCollapsed &&
															k.items.map(e => (
																<div
																	key={e.id}
																	role="button"
																	tabIndex={0}
																	className={`gui-ext-item${selectedId === e.id ? " gui-ext-item--selected" : ""}`}
																	onClick={() => setSelectedId(e.id)}
																	onKeyDown={ev => {
																		if (ev.key === "Enter" || ev.key === " ") {
																			ev.preventDefault();
																			setSelectedId(e.id);
																		}
																	}}
																>
																	<span
																		className={`gui-ext-dot${e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
																	/>
																	<span className="min-w-0 flex-1 truncate">{e.name}</span>
																	{isGuiKind(e) && <span className="gui-ext-item-tag gui-ext-item-tag--gui">GUI</span>}
																	<span className="gui-ext-item-tag">{levelLabel(e)}</span>
																	<span className="gui-ext-item-ops">
																		{isDeletable(e) && (
																			<button
																				type="button"
																				className="gui-icon-btn"
																				onClick={ev => {
																					ev.stopPropagation();
																					remove(e);
																				}}
																				title={t("delete skill")}
																				aria-label={t("delete skill")}
																			>
																				<Icon name="delete-bin" className="h-3 w-3" />
																			</button>
																		)}
																		<button
																			type="button"
																			role="switch"
																			aria-checked={e.state === "active"}
																			aria-label={
																				e.state === "active"
																					? t("disable skill")
																					: t("enable skill")
																			}
																			className={`gui-toggle gui-toggle--sm${e.state === "active" ? " gui-toggle--on" : ""}`}
																			onClick={ev => {
																				ev.stopPropagation();
																				toggle(e, e.state !== "active");
																			}}
																		>
																			<span className="gui-toggle-knob" />
																		</button>
																	</span>
																</div>
															))}
													</div>
												);
											})}
										</div>
									)}
								</div>
							);
						})}
						{tree.nativeItems.length > 0 && (
							<div className="gui-ext-provider">
								<div className="gui-ext-provider-h">
									<span className="gui-ext-dot" />
									<span className="min-w-0 flex-1 truncate text-[12px] font-medium">{t("ext builtin")}</span>
									<span className="gui-ext-group-count">({tree.nativeItems.length})</span>
								</div>
								<div className="gui-ext-provider-children">
									{tree.nativeItems.map(e => (
										<div
											key={e.id}
											role="button"
											tabIndex={0}
											className={`gui-ext-item${selectedId === e.id ? " gui-ext-item--selected" : ""}`}
											onClick={() => setSelectedId(e.id)}
										>
											<span
												className={`gui-ext-dot${e.state === "active" ? "" : e.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
											/>
											<span className="min-w-0 flex-1 truncate">{e.name}</span>
										</div>
									))}
								</div>
							</div>
						)}
						{filtered.length === 0 && <div className="gui-ext-empty">{t("no skills found")}</div>}
					</div>
				</div>
				{/* Right: detail pane (name / type / description / trigger /
				 * source / path / state / instructions / raw inspector). */}
				<div className="gui-ext-detail">
					{selected ? (
						<>
							<div className="gui-ext-detail-name">{selected.displayName}</div>
							<div className="gui-ext-detail-meta">
								{t("extension type")}: {kindLabel(selected.kind)}
								{isGuiKind(selected) && <span className="gui-ext-item-tag gui-ext-item-tag--gui">GUI</span>}
							</div>
							{selected.description && <p className="gui-ext-detail-desc">{selected.description}</p>}
							{selected.trigger && (
								<div className="gui-ext-detail-section">
									<div className="gui-ext-detail-label">{t("trigger")}</div>
									<div className="gui-ext-detail-path">{selected.trigger}</div>
								</div>
							)}
							<div className="gui-ext-detail-section">
								<div className="gui-ext-detail-label">{t("source")}</div>
								<div className="gui-ext-detail-value">
									{t("via {provider} ({level})", {
										provider: selected.source.providerName,
										level: levelLabel(selected),
									})}
								</div>
								<div className="gui-ext-detail-path">{selected.path}</div>
							</div>
							<div className="gui-ext-detail-section">
								<div className="gui-ext-detail-label">{t("status")}</div>
								<div
									className={`gui-ext-detail-status${selected.state === "active" ? " gui-ext-detail-status--active" : selected.state === "shadowed" ? " gui-ext-detail-status--shadowed" : ""}`}
								>
									<span
										className={`gui-ext-dot${selected.state === "active" ? "" : selected.state === "shadowed" ? " gui-ext-dot--shadowed" : " gui-ext-dot--off"}`}
									/>
									{stateLabel(selected)}
									{selected.state === "shadowed" && selected.shadowedBy && (
										<span className="gui-ext-detail-shadowed">
											{t("shadowed by {name}", { name: selected.shadowedBy })}
										</span>
									)}
								</div>
							</div>
							{(selected.kind === "skill" || selected.kind === "context-file") && (
								<div className="gui-ext-detail-section">
									<div className="gui-ext-detail-label">{t("instructions")}</div>
									<div className="gui-ext-detail-code">
										{detail ? (
											<pre>{detail.content}</pre>
										) : (
											<div className="text-[12px] text-[var(--color-text-faint)]">{t("no content")}</div>
										)}
									</div>
								</div>
							)}
							<div className="gui-ext-detail-section">
								<button
									type="button"
									className="gui-ext-detail-raw-toggle"
									onClick={loadRaw}
									aria-expanded={rawOpen}
								>
									<Icon name={rawOpen ? "arrow-down-s" : "arrow-right-s"} className="h-3.5 w-3.5" />
									{t("raw data")}
								</button>
								<HeightMorph morphKey={rawOpen ? "raw-open" : "raw-closed"}>
									{rawOpen && (
										<div className="gui-ext-detail-code">
											<pre>{raw ?? "…"}</pre>
										</div>
									)}
								</HeightMorph>
							</div>
							{isDeletable(selected) && (
								<div className="gui-ext-detail-actions">
									<button type="button" className="gui-btn" onClick={() => remove(selected)}>
										<Icon name="delete-bin" className="h-3.5 w-3.5" />
										{t("delete skill")}
									</button>
								</div>
							)}
						</>
					) : (
						<div className="gui-ext-detail-empty">{t("select an extension")}</div>
					)}
				</div>
			</div>
			{/* Bottom status bar (CCEC parity). */}
			<div className="gui-ext-statusbar">
				<span>{t("ext status hint")}</span>
				<span className="ml-auto truncate">
					{filtered.length} / {(extensions ?? []).length}
				</span>
			</div>
		</div>
	);
}
