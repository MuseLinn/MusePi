import { t } from "@musepi/desktop-web";
import type { ReactNode } from "react";
import { useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { FadeScroll } from "./FadeScroll";

interface AgentSource {
	source: string;
	name: string;
}

interface ForeignSessionRow {
	id: string;
	title: string;
	cwd: string;
	created: string;
	modified: string;
	messageCount: number;
	firstMessage: string;
}

interface ImportSource {
	source: string;
	name: string;
	count: number;
	sessions: ForeignSessionRow[];
}

interface WorkspaceGroup {
	cwd: string;
	sessions: ForeignSessionRow[];
}

/** Selection key — source and workspace the session lives in. */
const selKey = (source: string, cwd: string): string => `${source}\u0000${cwd}`;

/**
 * Import sessions from other agents (omp/pi/opencode/grok/kimi/claude/codex).
 *
 * Explicit three-step flow — nothing scans on entry:
 *   1. import.agents lists the candidate agents (no session scan);
 *   2. the user picks agents and clicks scan → import.sources scans ONLY the
 *      selected agents;
 *   3. results are grouped by workspace (session cwd), with per-workspace
 *      select-all, and import.session copies the picked sessions into MusePi
 *      (each keeps its original workspace directory).
 */
export function ImportSessionsSetup({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [agents, setAgents] = useState<AgentSource[] | null>(null);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [scanning, setScanning] = useState(false);
	const [scanError, setScanError] = useState<string | null>(null);
	/** null = picker phase (not scanned yet); [] = scanned, nothing found. */
	const [scanned, setScanned] = useState<ImportSource[] | null>(null);
	const [selected, setSelected] = useState<Record<string, Set<string>>>({});
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState<{ ok: number; failed: number } | null>(null);

	// Agent list only — deliberately cheap, no session store scan.
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<AgentSource[]>("import.agents", {})
			.then(list => {
				if (alive) setAgents(list ?? []);
			})
			.catch(() => {
				if (alive) setAgents([]);
			});
		return () => {
			alive = false;
		};
	}, [rpc]);

	const toggleAgent = (source: string): void => {
		setPicked(prev => {
			const next = new Set(prev);
			if (next.has(source)) next.delete(source);
			else next.add(source);
			return next;
		});
	};

	const scan = async (): Promise<void> => {
		if (!rpc || picked.size === 0 || scanning) return;
		setScanning(true);
		setScanError(null);
		setScanned(null);
		setSelected({});
		setDone(null);
		try {
			const list = await rpc.request<ImportSource[]>("import.sources", { sources: [...picked] });
			setScanned(list ?? []);
		} catch (err) {
			setScanError(err instanceof Error ? err.message : String(err));
		} finally {
			setScanning(false);
		}
	};

	const changeAgents = (): void => {
		setScanned(null);
		setSelected({});
		setScanError(null);
		setDone(null);
	};

	/** Per-source sessions grouped by workspace; empty cwd last. */
	const groupsBySource = useMemo(() => {
		const out: Record<string, WorkspaceGroup[]> = {};
		for (const src of scanned ?? []) {
			const byCwd = new Map<string, ForeignSessionRow[]>();
			for (const s of src.sessions) {
				const arr = byCwd.get(s.cwd) ?? [];
				arr.push(s);
				byCwd.set(s.cwd, arr);
			}
			out[src.source] = [...byCwd.entries()]
				.map(([cwd, sessions]) => ({ cwd, sessions }))
				.sort((a, b) => {
					if (!a.cwd && b.cwd) return 1;
					if (a.cwd && !b.cwd) return -1;
					return a.cwd.localeCompare(b.cwd);
				});
		}
		return out;
	}, [scanned]);

	const toggleSession = (source: string, cwd: string, id: string): void => {
		setSelected(prev => {
			const key = selKey(source, cwd);
			const next = new Set(prev[key] ?? []);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return { ...prev, [key]: next };
		});
	};

	const toggleWorkspace = (source: string, group: WorkspaceGroup): void => {
		setSelected(prev => {
			const key = selKey(source, group.cwd);
			const cur = prev[key] ?? new Set();
			const all = group.sessions.map(s => s.id);
			const allChecked = all.every(id => cur.has(id));
			const next = new Set(cur);
			for (const id of all) {
				if (allChecked) next.delete(id);
				else next.add(id);
			}
			return { ...prev, [key]: next };
		});
	};

	const totalSelected = useMemo(() => Object.values(selected).reduce((sum, set) => sum + set.size, 0), [selected]);

	const importSelected = async (): Promise<void> => {
		if (!rpc || totalSelected === 0 || busy) return;
		setBusy(true);
		setDone(null);
		let ok = 0;
		let failed = 0;
		for (const [key, ids] of Object.entries(selected)) {
			const source = key.split("\u0000")[0] ?? "";
			for (const id of ids) {
				try {
					// No cwd param: the daemon keeps the session's original
					// workspace directory (fallbackCwd = daemon cwd).
					await rpc.request("import.session", { source, id });
					ok += 1;
				} catch {
					failed += 1;
				}
			}
		}
		setBusy(false);
		setDone({ ok, failed });
		setSelected({});
	};

	return (
		<div className="flex flex-col gap-2">
			<p className="text-[12px] text-[var(--color-text-faint)]">{t("import sessions hint")}</p>
			{agents === null ? (
				<div className="text-[12px] text-[var(--color-text-faint)]">{t("loading…")}</div>
			) : scanned === null ? (
				<>
					{agents.length === 0 && (
						<div className="text-[12px] text-[var(--color-text-faint)]">{t("no agents")}</div>
					)}
					<FadeScroll className="flex max-h-48 flex-col gap-1 overflow-y-auto">
						{agents.map(agent => (
							<label key={agent.source} className="flex cursor-pointer items-center gap-2">
								<input
									type="checkbox"
									checked={picked.has(agent.source)}
									onChange={() => toggleAgent(agent.source)}
								/>
								<span className="text-[13px]">{agent.name}</span>
							</label>
						))}
					</FadeScroll>
					{scanError && <div className="text-[12px] text-[var(--color-danger)]">{scanError}</div>}
					<button
						type="button"
						className="gui-btn gui-btn-primary"
						disabled={scanning || picked.size === 0}
						onClick={() => void scan()}
					>
						{scanning ? t("scanning…") : t("scan")}
					</button>
				</>
			) : (
				<>
					{scanned.length === 0 && (
						<div className="text-[12px] text-[var(--color-text-faint)]">
							{t("no sessions found in selected agents")}
						</div>
					)}
					<FadeScroll className="flex max-h-64 flex-col gap-2 overflow-y-auto">
						{scanned.map(src => (
							<div key={src.source} className="rounded-lg border border-[var(--border)] p-2">
								<div className="flex items-center justify-between">
									<span className="text-[13px] font-semibold">{src.name}</span>
									<span className="text-[11px] text-[var(--color-text-faint)]">
										{t("session count label", { count: src.count })}
									</span>
								</div>
								<div className="mt-1 flex flex-col gap-1.5">
									{(groupsBySource[src.source] ?? []).map(group => {
										const key = selKey(src.source, group.cwd);
										const cur = selected[key] ?? new Set();
										const allChecked = group.sessions.every(s => cur.has(s.id));
										const someChecked = group.sessions.some(s => cur.has(s.id));
										return (
											<div key={group.cwd || "no-workspace"}>
												<label className="flex cursor-pointer items-center gap-2">
													<input
														type="checkbox"
														checked={allChecked}
														ref={el => {
															if (el) el.indeterminate = someChecked && !allChecked;
														}}
														onChange={() => toggleWorkspace(src.source, group)}
													/>
													<span className="min-w-0 flex-1 truncate text-[12px] font-medium">
														{group.cwd || t("no workspace")}
													</span>
													<span className="flex-none text-[10px] text-[var(--color-text-faint)]">
														{group.sessions.length}
													</span>
												</label>
												<div className="ml-5 flex flex-col gap-0.5">
													{group.sessions.map(s => {
														const checked = cur.has(s.id);
														return (
															<label key={s.id} className="flex cursor-pointer items-center gap-2">
																<input
																	type="checkbox"
																	checked={checked}
																	onChange={() => toggleSession(src.source, group.cwd, s.id)}
																/>
																<span className="min-w-0 flex-1 truncate text-[12px]">
																	{s.title || s.firstMessage || s.id}
																</span>
																<span className="flex-none text-[10px] text-[var(--color-text-faint)]">
																	{s.messageCount > 0 ? `${s.messageCount} msgs` : ""}
																</span>
															</label>
														);
													})}
												</div>
											</div>
										);
									})}
								</div>
							</div>
						))}
					</FadeScroll>
					{scanError && <div className="text-[12px] text-[var(--color-danger)]">{scanError}</div>}
					{done && (
						<div className="text-[12px] text-[var(--color-text-faint)]">
							{t("import done", { count: done.ok })}
							{done.failed > 0 ? ` · ${t("import failed", { count: done.failed })}` : ""}
						</div>
					)}
					<div className="flex items-center justify-between">
						<button
							type="button"
							className="gui-btn gui-btn-ghost"
							disabled={busy || scanning}
							onClick={changeAgents}
						>
							{t("change selection")}
						</button>
						<button
							type="button"
							className="gui-btn gui-btn-primary"
							disabled={busy || totalSelected === 0}
							onClick={() => void importSelected()}
						>
							{busy ? t("importing…") : t("import selected", { count: totalSelected })}
						</button>
					</div>
				</>
			)}
		</div>
	);
}
