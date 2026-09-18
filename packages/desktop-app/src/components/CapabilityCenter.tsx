import { Markdown, type MarketplaceCardAction, MarketplaceGrid, t } from "@musepi/guest-client";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { StateIcon } from "./StateIcon";

/**
 * 能力中心 (capability center) — the acquisition surface of the extensions
 * story, two screens deep:
 *
 *   ① installed — every discovered skill (skills.list) as a card grid;
 *      clicking a card opens the skill detail DRAWER (SKILL.md rendered,
 *      ignore toggle, delete for user-owned files).
 *   ② acquire — install NEW capabilities: skills.install from a Git URL
 *      (with overwrite retry on name conflicts) plus the shared
 *      MarketplaceGrid (marketplace.list / install / remove).
 *
 * The diagnostics tab (extensions health report) lives here too — it reads
 * the same daemon inventories and answers "why is X not working" in one
 * glance: load errors, shadowed items, skill discovery warnings, disabled
 * sources.
 */

/** One row of daemon skills.list (trimmed to what the UI renders). */
interface SkillRow {
	name: string;
	description: string;
	filePath: string;
	source: string;
	hide: boolean;
	content?: string;
	ignored: boolean;
	_source?: { provider: string; providerName: string; path: string; level: "user" | "project" | "native" };
}

function skillLevelLabel(s: SkillRow): string {
	const level = s._source?.level;
	if (!level || level === "native") return t("skill filter builtin");
	return level === "project" ? t("skill filter project") : t("skill filter user");
}

/** Diagnostics entry: one problem row with a kind badge + reason. */
interface DiagRow {
	id: string;
	kind: "load-error" | "shadowed" | "warning" | "provider-off";
	title: string;
	detail?: string;
}

interface DiagSection {
	kind: DiagRow["kind"];
	label: string;
	rows: DiagRow[];
}

/** 扩展健康诊断:一个聚合视图回答"为什么 X 没生效" —— 加载失败 / 遮蔽 /
 *  技能发现警告 / 已关闭来源,全部来自现有 extensions.list + skills.list。 */
function DiagnosticsView({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [rows, setRows] = useState<DiagRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void (async () => {
			try {
				const [ext, skills] = await Promise.all([
					rpc.request<{
						extensions: Array<{
							id: string;
							name: string;
							displayName?: string;
							kind: string;
							loadError?: string | null;
							state: string;
							shadowedBy?: string | null;
						}>;
						tabs?: Array<{ id: string; enabled: boolean }>;
					}>("extensions.list", {}),
					rpc.request<{ skills: unknown[]; warnings: string[] }>("skills.list", {}),
				]);
				if (!alive) return;
				const out: DiagRow[] = [];
				for (const e of ext?.extensions ?? []) {
					if (e.loadError) {
						out.push({ id: e.id, kind: "load-error", title: e.displayName ?? e.name, detail: e.loadError });
						continue;
					}
					if (e.state === "shadowed") {
						out.push({
							id: e.id,
							kind: "shadowed",
							title: e.displayName ?? e.name,
							detail: e.shadowedBy ? t("shadowed by {name}", { name: e.shadowedBy }) : undefined,
						});
					}
				}
				for (const w of skills?.warnings ?? []) {
					out.push({ id: `w:${out.length}`, kind: "warning", title: w });
				}
				for (const tab of ext?.tabs ?? []) {
					if (!tab.enabled) {
						out.push({ id: `t:${tab.id}`, kind: "provider-off", title: tab.id });
					}
				}
				setRows(out);
			} catch (e: unknown) {
				if (alive) setError(e instanceof Error ? e.message : String(e));
			}
		})();
		return () => {
			alive = false;
		};
	}, [rpc]);

	const sections: DiagSection[] = [
		{ kind: "load-error", label: t("diag load errors"), rows: (rows ?? []).filter(r => r.kind === "load-error") },
		{ kind: "shadowed", label: t("diag shadowed"), rows: (rows ?? []).filter(r => r.kind === "shadowed") },
		{ kind: "warning", label: t("diag warnings"), rows: (rows ?? []).filter(r => r.kind === "warning") },
		{
			kind: "provider-off",
			label: t("diag disabled providers"),
			rows: (rows ?? []).filter(r => r.kind === "provider-off"),
		},
	];

	return (
		<div className="gui-cap-diag">
			{error && <div className="gui-ext-plugins-error">{error}</div>}
			{rows !== null && rows.length === 0 && (
				<div className="gui-cap-diag-clear">
					<Icon name="shield-check" className="h-4 w-4" />
					<span>{t("diagnostics all clear")}</span>
				</div>
			)}
			{sections.map(
				sec =>
					sec.rows.length > 0 && (
						<div key={sec.kind} className="gui-cap-diag-section">
							<div className="gui-cap-diag-head">
								<Icon
									name={
										sec.kind === "load-error"
											? "alert"
											: sec.kind === "shadowed"
												? "eye"
												: sec.kind === "warning"
													? "alert"
													: "pause"
									}
									className="h-3.5 w-3.5 shrink-0 opacity-70"
								/>
								<span className="text-[12px] font-medium">{sec.label}</span>
								<span className="gui-ext-group-count">({sec.rows.length})</span>
							</div>
							{sec.rows.map(r => (
								<div key={r.id} className="gui-cap-diag-row">
									<span className="gui-cap-diag-title">{r.title}</span>
									{r.detail && (
										<span className="gui-cap-diag-detail" title={r.detail}>
											{r.detail}
										</span>
									)}
								</div>
							))}
						</div>
					),
			)}
		</div>
	);
}

/** 技能详情抽屉:右侧滑出,渲染 skills.read 的 SKILL.md(相对路径以技能
 *  文件目录为 basePath),头部带 ignore 开关 + 删除(user 级文件技能)。 */
function SkillDrawer({
	rpc,
	skill,
	onClose,
	onChanged,
	onDeleted,
}: {
	rpc: RpcClient;
	skill: SkillRow;
	onClose(): void;
	onChanged(): void;
	onDeleted(name: string): void;
}): ReactNode {
	const [detail, setDetail] = useState<{ content: string; filePath: string } | null>(null);
	const [error, setError] = useState<string | null>(null);
	const { confirm } = useConfirm();

	useEffect(() => {
		let alive = true;
		setDetail(null);
		setError(null);
		// Virtual skills (extension-declared) carry their body in the list
		// entry itself — no file, no skills.read round-trip.
		if (skill.content) {
			setDetail({ content: skill.content, filePath: "" });
			return () => {
				alive = false;
			};
		}
		void rpc
			.request<{ content: string; filePath: string }>("skills.read", { name: skill.name })
			.then(res => {
				if (alive) setDetail(res ? { content: res.content, filePath: res.filePath } : null);
			})
			.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	}, [rpc, skill.name, skill.content]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [onClose]);

	const canDelete = skill.filePath !== "" && skill._source?.level === "user" && !skill.source.startsWith("managed");

	// Ignore 切换 = settings.set("skills.ignoredSkills") 的 read-modify-write:
	// daemon 按 Bun.Glob 逐模式匹配技能名,追加/移除精确名是安全的最小修改。
	const toggleIgnored = (): void => {
		void (async () => {
			try {
				const cur = await rpc.request<{ "skills.ignoredSkills"?: string[] }>("settings.get", {
					keys: ["skills.ignoredSkills"],
				});
				const patterns = new Set(cur?.["skills.ignoredSkills"] ?? []);
				if (skill.ignored) patterns.delete(skill.name);
				else patterns.add(skill.name);
				await rpc.request("settings.set", {
					key: "skills.ignoredSkills",
					value: [...patterns],
				});
				onChanged();
			} catch (e: unknown) {
				setError(e instanceof Error ? e.message : String(e));
			}
		})();
	};

	const removeSkill = (): void => {
		void confirm(t("delete skill confirm {name}", { name: skill.name }), t("delete")).then(ok => {
			if (!ok) return;
			void rpc
				.request("skills.delete", { name: skill.name })
				.then(() => {
					onDeleted(skill.name);
					onClose();
				})
				.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
		});
	};

	const basePath = detail?.filePath ? detail.filePath.replace(/[/\\]SKILL\.md$/i, "") : undefined;

	return (
		<div className="gui-cap-drawer-root" role="dialog" aria-modal>
			<div className="gui-cap-drawer-backdrop" onClick={onClose} />
			<div className="gui-cap-drawer">
				<div className="gui-cap-drawer-head">
					<div className="gui-cap-drawer-titles">
						<div className="gui-cap-drawer-name">{skill.name}</div>
						<div className="gui-cap-drawer-meta">
							<span className="gui-ext-item-tag">{skillLevelLabel(skill)}</span>
							{skill.ignored && <span className="gui-ext-item-tag gui-ext-item-tag--err">{t("ignored")}</span>}
						</div>
					</div>
					<button type="button" className="gui-cap-drawer-close" aria-label={t("close")} onClick={onClose}>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
				{error && <div className="gui-ext-plugins-error">{error}</div>}
				<div className="gui-cap-drawer-body">
					{detail ? (
						<Markdown text={detail.content} basePath={basePath} />
					) : (
						<div className="text-[12px] text-[var(--color-text-faint)]">{t("no content")}</div>
					)}
				</div>
				<div className="gui-cap-drawer-actions">
					<button
						type="button"
						role="switch"
						aria-checked={skill.ignored}
						className={`gui-toggle gui-toggle--sm${skill.ignored ? " gui-toggle--on" : ""}`}
						aria-label={t("toggle skill ignore", { name: skill.name })}
						onClick={toggleIgnored}
					/>
					<span className="gui-cap-drawer-actions-label">
						{skill.ignored ? t("ignored") : t("extension active")}
					</span>
					{canDelete && (
						<button type="button" className="gui-btn gui-cap-drawer-delete" onClick={removeSkill}>
							<Icon name="delete-bin" className="h-3.5 w-3.5" />
							{t("delete skill")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}

/** 屏 2 的"从 Git 安装技能"卡:URL(+可选名称)→ skills.install;
 *  名称冲突时给出覆盖安装重试。 */
function GitInstallCard({ rpc, onInstalled }: { rpc: RpcClient; onInstalled(): void }): ReactNode {
	const [url, setUrl] = useState("");
	const [name, setName] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<{ ok: boolean; text: string; canOverwrite: boolean } | null>(null);

	const install = async (overwrite: boolean): Promise<void> => {
		if (!url.trim() || busy) return;
		setBusy(true);
		setMsg(null);
		try {
			const res = await rpc.request<{ ok: boolean; name: string; dir: string }>("skills.install", {
				url: url.trim(),
				...(name.trim() ? { name: name.trim() } : {}),
				...(overwrite ? { overwrite: true } : {}),
			});
			setMsg({ ok: true, text: t("skill installed {name}", { name: res?.name ?? "" }), canOverwrite: false });
			setUrl("");
			setName("");
			onInstalled();
		} catch (e: unknown) {
			const text = e instanceof Error ? e.message : String(e);
			// Name conflicts surface as an explicit retry affordance instead of
			// a dead error line — overwrite is the expected second click.
			setMsg({ ok: false, text, canOverwrite: /exist|conflict|overwrite/i.test(text) });
		} finally {
			setBusy(false);
		}
	};

	return (
		<div className="gui-cap-install-card">
			<div className="gui-cap-install-head">
				<Icon name="download" className="h-3.5 w-3.5 shrink-0 opacity-70" />
				<span className="text-[12px] font-medium">{t("install from git")}</span>
			</div>
			<input
				className="gui-cap-install-input"
				placeholder={t("git url hint")}
				value={url}
				onChange={e => setUrl(e.target.value)}
				spellCheck={false}
			/>
			<input
				className="gui-cap-install-input"
				placeholder={t("optional name override")}
				value={name}
				onChange={e => setName(e.target.value)}
				spellCheck={false}
			/>
			<div className="gui-cap-install-foot">
				<button
					type="button"
					className="gui-btn"
					disabled={busy || url.trim().length === 0}
					onClick={() => void install(false)}
				>
					{busy ? t("installing") : t("install skill")}
				</button>
				{msg?.canOverwrite && (
					<button type="button" className="gui-btn" disabled={busy} onClick={() => void install(true)}>
						{t("overwrite install")}
					</button>
				)}
			</div>
			{msg && <div className={`gui-cap-install-msg${msg.ok ? " gui-cap-install-msg--ok" : ""}`}>{msg.text}</div>}
		</div>
	);
}

export function CapabilityCenter({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [screen, setScreen] = useState<"installed" | "acquire">("installed");
	const [skills, setSkills] = useState<SkillRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [drawerName, setDrawerName] = useState<string | null>(null);

	// 拉取技能清单:进入 tab / 从获取屏返回时刷新(daemon 侧另有 10s TTL)。
	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ skills: SkillRow[] }>("skills.list", {})
			.then(res => {
				if (!alive) return;
				setSkills(res?.skills ?? []);
				setError(null);
			})
			.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	}, [rpc, screen]);

	const filtered = useMemo(() => {
		const list = skills ?? [];
		const q = query.trim().toLowerCase();
		if (!q) return list;
		return list.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q));
	}, [skills, query]);

	const drawer = useMemo(() => {
		if (!drawerName || !skills) return null;
		return skills.find(s => s.name === drawerName) ?? null;
	}, [drawerName, skills]);

	// MarketplaceGrid's duck-typed client + action routing (same shape the
	// extensions marketplace tab uses).
	const client = rpc ? { rpc: <T,>(m: string, p?: unknown): Promise<T> => rpc.request<T>(m, p) } : null;
	const handleMarketAction = async (action: MarketplaceCardAction): Promise<void> => {
		if (!rpc || action.kind === "open") return;
		const method = action.kind === "install" ? "marketplace.install" : "marketplace.remove";
		await rpc.request(method, {
			name: action.entry.name,
			marketplace: action.entry.marketplace ?? "default",
		});
	};

	return (
		<div className="gui-cap">
			{/* Two-screen header: breadcrumb-style back + title + actions. */}
			<div className="gui-cap-head">
				{screen === "acquire" ? (
					<button type="button" className="gui-cap-back" onClick={() => setScreen("installed")}>
						<StateIcon on={false} pair={["arrow-right-s", "arrow-left-s"]} className="h-4 w-4" />
						{t("installed capabilities")}
					</button>
				) : (
					<div className="gui-cap-search">
						<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
						<input
							className="min-w-0 flex-1 bg-transparent text-[12.5px] outline-none"
							placeholder={t("search skills...")}
							value={query}
							onChange={e => setQuery(e.target.value)}
						/>
					</div>
				)}
				{screen === "installed" ? (
					<button type="button" className="gui-cap-acquire-btn" onClick={() => setScreen("acquire")}>
						<Icon name="download" className="h-3.5 w-3.5 shrink-0" />
						{t("acquire capabilities")}
					</button>
				) : (
					<div className="gui-cap-head-title">{t("acquire capabilities")}</div>
				)}
			</div>
			{error && <div className="gui-ext-plugins-error">{error}</div>}

			{screen === "installed" ? (
				<div className="gui-cap-grid-wrap">
					{filtered.length === 0 ? (
						<div className="gui-cap-empty">
							<Icon name="star" className="h-5 w-5 opacity-50" />
							<div>{t("no skills installed")}</div>
							<div className="gui-cap-empty-hint">{t("install one from git or the marketplace")}</div>
							<button type="button" className="gui-btn" onClick={() => setScreen("acquire")}>
								<Icon name="download" className="h-3.5 w-3.5" />
								{t("acquire capabilities")}
							</button>
						</div>
					) : (
						<div className="gui-cap-grid">
							{filtered.map(s => (
								<div
									key={s.name}
									role="button"
									tabIndex={0}
									className="gui-cap-card"
									onClick={() => setDrawerName(s.name)}
									onKeyDown={e => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault();
											setDrawerName(s.name);
										}
									}}
								>
									<div className="gui-cap-card-top">
										<span className="gui-cap-card-name">{s.name}</span>
										<span className="gui-ext-item-tag">{skillLevelLabel(s)}</span>
									</div>
									<div className="gui-cap-card-desc">{s.description || "—"}</div>
									<div className="gui-cap-card-foot">
										{s.ignored && (
											<span className="gui-ext-item-tag gui-ext-item-tag--err">{t("ignored")}</span>
										)}
										{s.hide && <span className="gui-ext-item-tag">{t("skill hidden")}</span>}
									</div>
								</div>
							))}
						</div>
					)}
				</div>
			) : (
				<div className="gui-cap-acquire">
					{rpc && <GitInstallCard rpc={rpc} onInstalled={() => setScreen("installed")} />}
					<div className="gui-cap-mkt">
						<div className="gui-cap-mkt-head">
							<Icon name="plug-2" className="h-3.5 w-3.5 shrink-0 opacity-70" />
							<span className="text-[12px] font-medium">{t("skills marketplace")}</span>
						</div>
						<MarketplaceGrid client={client} onAction={action => void handleMarketAction(action)} />
					</div>
				</div>
			)}

			{rpc && drawer && (
				<SkillDrawer
					rpc={rpc}
					skill={drawer}
					onClose={() => setDrawerName(null)}
					onChanged={() => {
						// ignore 翻转后重拉列表(单例轮询不等这个 tab)。
						setDrawerName(drawer.name);
						if (!rpc) return;
						void rpc
							.request<{ skills: SkillRow[] }>("skills.list", {})
							.then(res => setSkills(res?.skills ?? []))
							.catch(() => {});
					}}
					onDeleted={name => setSkills(prev => (prev ?? []).filter(s => s.name !== name))}
				/>
			)}
		</div>
	);
}

export { DiagnosticsView };
