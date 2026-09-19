import { Markdown, type MarketplaceCardAction, MarketplaceGrid, t } from "@musepi/guest-client";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { useConfirm } from "../lib/prompt-dialog";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { StateIcon } from "./StateIcon";

/**
 * 能力中心 (capability center) — the acquisition surface of the extensions
 * story, two screens deep:
 *
 *   ① installed — every discovered skill (skills.list) as a card grid,
 *      framed like 设计稿 frame 2:250: 来源/排序 双下拉 + 批量管理开关、
 *      级别筛选 chips、`全部技能 · N` 标题行 + 网格/列表切换、方形彩色
 *      字形图标卡、以及底部批量操作条。
 *      Clicking a card opens the skill detail DRAWER (SKILL.md rendered,
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

/** 级别:内置 / 用户级 / 项目级 —— 同时也是 2:250 的筛选 chip 维度。 */
type LevelKey = "builtin" | "user" | "project";

function skillLevel(s: SkillRow): LevelKey {
	const level = s._source?.level;
	if (!level || level === "native") return "builtin";
	return level === "project" ? "project" : "user";
}

function skillLevelLabel(s: SkillRow): string {
	const key = skillLevel(s);
	return key === "builtin"
		? t("skill filter builtin")
		: key === "project"
			? t("skill filter project")
			: t("skill filter user");
}

/** 卡片副行:`官方 · SkillHub · v2.1.0` 的同一根线索在列表视图复用。 */
function skillOriginLabel(s: SkillRow): string {
	const provider = s._source?.providerName ?? s._source?.provider ?? s.source;
	if (s.source.startsWith("managed")) return t("skill origin official");
	if (s.filePath === "") return t("skill origin extension");
	return provider || t("skill origin local");
}

function skillVersionLabel(s: SkillRow): string {
	const version = (s as { version?: string }).version;
	return version ? `v${version}` : t("skill version unpinned");
}

/** 卡片上的字形图标:有 iconUrl 用图,否则取首字符 + 按名字取色的方块。
 *  色相由名字 hash 决定,所以同一技能的两个视图永远同色。 */
function hashHue(seed: string): number {
	let h = 0;
	for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
	return h;
}

function SkillGlyph({ skill, size }: { skill: SkillRow; size: number }): ReactNode {
	const iconUrl = (skill as { iconUrl?: string }).iconUrl;
	const [broken, setBroken] = useState(false);
	const hue = hashHue(skill.name);
	const style = { width: size, height: size, borderRadius: 8 } as const;
	if (iconUrl && !broken) {
		return (
			<img
				className="gui-cap-glyph"
				src={iconUrl}
				alt=""
				style={style}
				onError={() => setBroken(true)}
				loading="lazy"
			/>
		);
	}
	return (
		<span
			className="gui-cap-glyph gui-cap-glyph--initial"
			style={{ ...style, background: `oklch(0.30 0.07 ${hue})`, color: `oklch(0.86 0.10 ${hue})` }}
			aria-hidden
		>
			{skill.name.slice(0, 1).toUpperCase()}
		</span>
	);
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
 *  技能发现警告 / 已关闭来源。extensions/tabs 直接吃父级 registry 单例
 *  (数据已在内存,切 tab 即渲染);只自拉 skills.list 的警告(轻量 TTL 缓存)。
 *  之前这个视图自己重拉 extensions.list + skills.list —— 全量扩展扫描慢,
 *  且 rows===null 时整块空白,与"全部健康"无法区分,用户看到的是"空白 +
 *  转半天";registry 就绪前渲染骨架占位。 */
function DiagnosticsView({
	rpc,
	extensions,
	tabs,
}: {
	rpc: RpcClient | null;
	extensions: Array<{
		id: string;
		name: string;
		displayName?: string;
		loadError?: string | null;
		state: string;
		shadowedBy?: string | null;
	}> | null;
	tabs: Array<{ id: string; enabled: boolean }>;
}): ReactNode {
	const [warnings, setWarnings] = useState<string[] | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ skills: unknown[]; warnings: string[] }>("skills.list", {})
			.then(res => {
				if (alive) setWarnings(res?.warnings ?? []);
			})
			.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)));
		return () => {
			alive = false;
		};
	}, [rpc]);

	const rows: DiagRow[] = useMemo(() => {
		const out: DiagRow[] = [];
		for (const e of extensions ?? []) {
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
		for (const w of warnings ?? []) {
			out.push({ id: `w:${out.length}`, kind: "warning", title: w });
		}
		for (const tab of tabs) {
			if (!tab.enabled) out.push({ id: `t:${tab.id}`, kind: "provider-off", title: tab.id });
		}
		return out;
	}, [extensions, warnings, tabs]);

	const loading = extensions === null;

	const sections: DiagSection[] = [
		{ kind: "load-error", label: t("diag load errors"), rows: rows.filter(r => r.kind === "load-error") },
		{ kind: "shadowed", label: t("diag shadowed"), rows: rows.filter(r => r.kind === "shadowed") },
		{ kind: "warning", label: t("diag warnings"), rows: rows.filter(r => r.kind === "warning") },
		{
			kind: "provider-off",
			label: t("diag disabled providers"),
			rows: rows.filter(r => r.kind === "provider-off"),
		},
	];

	return (
		<div className="gui-cap-diag">
			{error && <div className="gui-ext-plugins-error">{error}</div>}
			{loading ? (
				// 骨架:registry 首拉未就绪 —— 占位节奏与概览统计卡同宽。
				[0, 1, 2].map(i => <div key={i} className="gui-cap-diag-skeleton" aria-hidden />)
			) : (
				<>
					{rows.length === 0 && (
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
				</>
			)}
		</div>
	);
}

/** 技能详情抽屉 (设计稿 2:665):右侧滑出的页面内面板 —— 不盖顶栏/工具行,
 *  四面圆角 + 液态玻璃。头部字形图标 + meta 行,动作行(在会话中调用 =
 *  复制 /skill-name、停用 = ignore 开关、卸载 = user 级文件技能),3 tab
 *  (概览 / SKILL.md / 版本记录),概览底部挂卸载风险块。
 *  收起走退场动画:closing 态先播 gui-cap-drawer-out,onAnimationEnd 再
 *  真正卸载 —— React 直接卸载是不会有退场动画的;prefers-reduced-motion
 *  时跳过动画立即关。 */
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
	const [tab, setTab] = useState<"overview" | "skillmd" | "versions">("overview");
	const [closing, setClosing] = useState(false);
	const [copied, setCopied] = useState(false);
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

	const requestClose = useCallback((): void => {
		if (closing) return;
		if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
			onClose();
			return;
		}
		setClosing(true);
	}, [closing, onClose]);

	useEffect(() => {
		const onKey = (e: KeyboardEvent): void => {
			if (e.key === "Escape") requestClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [requestClose]);

	// 「已复制」反馈自动消退(按钮图标回位,不弹 toast —— 抽屉内就地反馈)。
	useEffect(() => {
		if (!copied) return;
		const id = window.setTimeout(() => setCopied(false), 1800);
		return () => window.clearTimeout(id);
	}, [copied]);

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
					requestClose();
				})
				.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
		});
	};

	// 能力中心在设置窗口,没有会话可注入 —— 「在会话中调用」诚实落地为
	// 复制 slash 命令,用户粘贴到会话即触发。
	const invokeSkill = (): void => {
		void navigator.clipboard
			.writeText(`/${skill.name}`)
			.then(() => setCopied(true))
			.catch(() => {});
	};

	const basePath = detail?.filePath ? detail.filePath.replace(/[/\\]SKILL\.md$/i, "") : undefined;
	const metaText = [skillOriginLabel(skill), skillVersionLabel(skill), skillLevelLabel(skill)].join(" · ");

	return (
		<div className={`gui-cap-drawer-root${closing ? " gui-cap-drawer-root--closing" : ""}`} role="dialog" aria-modal>
			<div className="gui-cap-drawer-backdrop" onClick={requestClose} />
			<div
				className="gui-cap-drawer"
				onAnimationEnd={e => {
					if (closing && e.animationName === "gui-cap-drawer-out") onClose();
				}}
			>
				<div className="gui-cap-drawer-head">
					<SkillGlyph skill={skill} size={40} />
					<div className="gui-cap-drawer-titles">
						<div className="gui-cap-drawer-name">{skill.name}</div>
						<div className="gui-cap-drawer-meta">
							<span className="gui-cap-drawer-meta-text">{metaText}</span>
							{skill.ignored && (
								<span className="gui-ext-item-tag gui-ext-item-tag--err">{t("skill disabled")}</span>
							)}
						</div>
					</div>
					<button type="button" className="gui-cap-drawer-close" aria-label={t("close")} onClick={requestClose}>
						<Icon name="close" className="h-4 w-4" />
					</button>
				</div>
				<div className="gui-cap-drawer-actions">
					<button type="button" className="gui-btn gui-cap-drawer-primary" onClick={invokeSkill}>
						<Icon name={copied ? "check" : "external-link"} className="h-3.5 w-3.5" />
						{copied ? t("skill invoke copied") : t("skill invoke")}
					</button>
					<button type="button" className="gui-btn" onClick={toggleIgnored}>
						{skill.ignored ? t("skill enabled") : t("skill disable")}
					</button>
					{canDelete && (
						<button type="button" className="gui-btn gui-cap-drawer-delete" onClick={removeSkill}>
							{t("uninstall")}
						</button>
					)}
				</div>
				{error && <div className="gui-ext-plugins-error">{error}</div>}
				<div className="gui-cap-drawer-tabs" role="tablist">
					{(
						[
							["overview", t("skill tab overview")],
							["skillmd", t("skill tab skillmd")],
							["versions", t("skill tab versions")],
						] as const
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							role="tab"
							aria-selected={tab === id}
							className={`gui-cap-drawer-tab${tab === id ? " gui-cap-drawer-tab--on" : ""}`}
							onClick={() => setTab(id)}
						>
							{label}
						</button>
					))}
				</div>
				<div className="gui-cap-drawer-body">
					{tab === "overview" && (
						<div className="gui-cap-drawer-overview">
							{skill.description && (
								<>
									<div className="gui-cap-drawer-section">{t("skill overview summary")}</div>
									<p className="gui-cap-drawer-section-text">{skill.description}</p>
								</>
							)}
							<div className="gui-cap-drawer-section">{t("skill kv source group")}</div>
							<div className="gui-cap-drawer-kv">
								<span className="gui-cap-drawer-kv-key">{t("skill kv source")}</span>
								<span className="gui-cap-drawer-kv-val">{skillOriginLabel(skill)}</span>
								<span className="gui-cap-drawer-kv-key">{t("skill kv level")}</span>
								<span className="gui-cap-drawer-kv-val">{skillLevelLabel(skill)}</span>
								<span className="gui-cap-drawer-kv-key">{t("version")}</span>
								<span className="gui-cap-drawer-kv-val">{skillVersionLabel(skill)}</span>
								<span className="gui-cap-drawer-kv-key">{t("skill kv path")}</span>
								<span className="gui-cap-drawer-kv-val gui-cap-drawer-kv-val--mono">
									{skill.filePath || t("skill kv path virtual")}
								</span>
							</div>
							{canDelete && (
								<div className="gui-cap-drawer-risk">
									<Icon name="alert" className="h-3.5 w-3.5 shrink-0" />
									<span>{t("skill risk body")}</span>
								</div>
							)}
						</div>
					)}
					{tab === "skillmd" &&
						(detail ? (
							<Markdown text={detail.content} basePath={basePath} />
						) : (
							<div className="text-[12px] text-[var(--color-text-faint)]">{t("no content")}</div>
						))}
					{tab === "versions" && (
						<div className="gui-cap-drawer-overview">
							<div className="gui-cap-drawer-kv">
								<span className="gui-cap-drawer-kv-key">{t("version")}</span>
								<span className="gui-cap-drawer-kv-val">{skillVersionLabel(skill)}</span>
								<span className="gui-cap-drawer-kv-key">{t("skill kv source")}</span>
								<span className="gui-cap-drawer-kv-val">{skillOriginLabel(skill)}</span>
							</div>
							<div className="gui-cap-drawer-versions-empty">{t("skill versions empty")}</div>
						</div>
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

/**
 * 我安装的 (设计稿 frame 2:250).
 *
 * 三个可操作维度都映射到 daemon 已有的开关,没有新状态:
 *   批量启用/停用 → skills.ignoredSkills (read-modify-write,与抽屉同一条路径)
 *   卸载         → skills.delete (daemon 侧守卫:仅 user 级文件技能)
 *   筛选/排序    → 纯客户端,不动 RPC
 * 内置技能与扩展声明的虚拟技能不可卸载 —— 卡片上以"内置 · 随客户端分发 ·
 * 不可卸载"明示,批量卸载整批跳过它们(daemon 会拒绝,不如不让用户点)。
 */
function InstalledSkillsPane({
	rpc,
	onCountChange,
	onAcquire,
}: {
	rpc: RpcClient | null;
	onCountChange?(n: number): void;
	onAcquire(): void;
}): ReactNode {
	const [skills, setSkills] = useState<SkillRow[] | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [level, setLevel] = useState<"all" | LevelKey | "disabled">("all");
	const [origin, setOrigin] = useState<"all" | "official" | "user" | "project" | "extension">("all");
	const [sortKey, setSortKey] = useState<"recent" | "name" | "level">("recent");
	const [view, setView] = useState<"grid" | "list">("grid");
	const [manage, setManage] = useState(false);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [drawerName, setDrawerName] = useState<string | null>(null);
	const { confirm } = useConfirm();

	// 拉取技能清单:挂载时 + 每次批量操作后(daemon 侧另有 10s TTL)。
	const reload = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ skills: SkillRow[] }>("skills.list", {})
			.then(res => {
				const rows = res?.skills ?? [];
				setSkills(rows);
				setError(null);
				onCountChange?.(rows.length);
			})
			.catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
	}, [rpc, onCountChange]);

	useEffect(() => {
		reload();
	}, [reload]);

	/** 卡片/列表行上"是否可批量操作"的单一判据,批量按钮与行内徽标共用。 */
	const uninstallable = useCallback(
		(s: SkillRow): boolean => s.filePath !== "" && s._source?.level === "user" && !s.source.startsWith("managed"),
		[],
	);

	const counts = useMemo(() => {
		const list = skills ?? [];
		return {
			total: list.length,
			official: list.filter(s => s.source.startsWith("managed") || skillLevel(s) === "builtin").length,
			user: list.filter(s => skillLevel(s) === "user").length,
			project: list.filter(s => skillLevel(s) === "project").length,
			disabled: list.filter(s => s.ignored).length,
		};
	}, [skills]);

	const filtered = useMemo(() => {
		let list = skills ?? [];
		const q = query.trim().toLowerCase();
		if (q) {
			list = list.filter(s => s.name.toLowerCase().includes(q) || (s.description ?? "").toLowerCase().includes(q));
		}
		if (level === "disabled") list = list.filter(s => s.ignored);
		else if (level !== "all") list = list.filter(s => skillLevel(s) === level);
		if (origin === "official") list = list.filter(s => s.source.startsWith("managed"));
		else if (origin === "extension") list = list.filter(s => s.filePath === "");
		else if (origin === "user") list = list.filter(s => skillLevel(s) === "user");
		else if (origin === "project") list = list.filter(s => skillLevel(s) === "project");
		const rank: Record<LevelKey, number> = { builtin: 0, project: 1, user: 2 };
		const sorted = [...list];
		if (sortKey === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
		else if (sortKey === "level") sorted.sort((a, b) => rank[skillLevel(a)] - rank[skillLevel(b)]);
		else {
			// "最近使用" 的 daemon 端排名尚未暴露,退化为"启用先于停用、同级保持
			// 发现顺序" —— 至少让被停用的沉到底部,不假装有时间戳。
			sorted.sort((a, b) => Number(a.ignored) - Number(b.ignored));
		}
		return sorted;
	}, [skills, query, level, origin, sortKey]);

	const drawer = useMemo(() => {
		if (!drawerName || !skills) return null;
		return skills.find(s => s.name === drawerName) ?? null;
	}, [drawerName, skills]);

	/** 批量启停:一次 read-modify-write 写 full pattern set,再刷新。
	 *  与抽屉里的切换共用 skills.ignoredSkills,不是第二条路径。 */
	const setIgnoredBatch = useCallback(
		async (names: string[], ignored: boolean): Promise<void> => {
			if (!rpc || names.length === 0) return;
			setBusy(true);
			try {
				const cur = await rpc.request<{ "skills.ignoredSkills"?: string[] }>("settings.get", {
					keys: ["skills.ignoredSkills"],
				});
				const patterns = new Set(cur?.["skills.ignoredSkills"] ?? []);
				for (const n of names) {
					if (ignored) patterns.add(n);
					else patterns.delete(n);
				}
				await rpc.request("settings.set", { key: "skills.ignoredSkills", value: [...patterns] });
				reload();
				setSelected(new Set());
			} catch (e: unknown) {
				setError(e instanceof Error ? e.message : String(e));
			} finally {
				setBusy(false);
			}
		},
		[rpc, reload],
	);

	const uninstallSelected = useCallback(async (): Promise<void> => {
		if (!rpc || selected.size === 0) return;
		const names = [...selected].filter(n => {
			const s = (skills ?? []).find(x => x.name === n);
			return s ? uninstallable(s) : false;
		});
		const skipped = selected.size - names.length;
		const ok = await confirm(
			skipped > 0
				? t("uninstall skills confirm partial {n} {skipped}", { n: names.length, skipped })
				: t("uninstall skills confirm {n}", { n: names.length }),
			t("uninstall"),
		);
		if (!ok) return;
		setBusy(true);
		try {
			// 逐个删:daemon 每个技能一次 skills.delete,部分失败不打断其余。
			const results = await Promise.allSettled(names.map(n => rpc.request("skills.delete", { name: n })));
			const failed = results.filter(r => r.status === "rejected").length;
			if (failed > 0) setError(t("uninstall some failed {n}", { n: failed }));
			reload();
			setSelected(new Set());
		} finally {
			setBusy(false);
		}
	}, [rpc, selected, skills, uninstallable, confirm, reload]);

	const toggleSelected = (name: string): void => {
		setSelected(prev => {
			const next = new Set(prev);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});
	};

	const allSelected = filtered.length > 0 && filtered.every(s => selected.has(s.name));
	const selectedRows = (skills ?? []).filter(s => selected.has(s.name));
	const selectedUninstallable = selectedRows.filter(uninstallable).length;

	const levelChips: Array<{ id: "all" | LevelKey | "disabled"; label: string }> = [
		{ id: "all", label: t("skill filter all") },
		{ id: "builtin", label: t("skill filter official") },
		{ id: "user", label: t("skill filter user") },
		{ id: "project", label: t("skill filter project") },
		{ id: "disabled", label: t("skill filter disabled") },
	];

	return (
		<div className="gui-skill-installed">
			{/* 工具行:来源/排序 双下拉 + 批量管理开关 (设计稿 2:250)。 */}
			<div className="gui-skill-market-bar">
				<label className="gui-skill-market-search">
					<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
					<input
						type="search"
						placeholder={t("search skills...")}
						value={query}
						onChange={e => setQuery(e.target.value)}
					/>
				</label>
				<label className="gui-skill-market-select">
					<select
						value={origin}
						aria-label={t("skill market source")}
						onChange={e => setOrigin(e.target.value as typeof origin)}
					>
						<option value="all">{t("skill market source all")}</option>
						<option value="official">{t("skill origin official")}</option>
						<option value="user">{t("skill filter user")}</option>
						<option value="project">{t("skill filter project")}</option>
						<option value="extension">{t("skill origin extension")}</option>
					</select>
				</label>
				<label className="gui-skill-market-select">
					<select
						value={sortKey}
						aria-label={t("skill market sort")}
						onChange={e => setSortKey(e.target.value as typeof sortKey)}
					>
						<option value="recent">{t("skill sort recent")}</option>
						<option value="name">{t("skill sort name")}</option>
						<option value="level">{t("skill sort level")}</option>
					</select>
				</label>
				<button
					type="button"
					className={`gui-cap-manage${manage ? " gui-cap-manage--on" : ""}`}
					aria-pressed={manage}
					onClick={() => {
						setManage(v => !v);
						if (manage) setSelected(new Set());
					}}
				>
					<StateIcon on={manage} pair={["checkbox-blank", "checkbox-circle"]} className="h-3.5 w-3.5" />
					{t("skill manage")}
				</button>
			</div>

			{/* 工具行以下的全部内容:详情抽屉的定位容器。抽屉 absolute 覆盖
			 *  这一壳层 —— 顶栏/工具行保持在遮罩之外 (设计稿 2:665)。 */}
			<div className="gui-skill-installed-rest">
				{/* 级别筛选 chips。 */}
				<div className="gui-skill-market-chips">
					{levelChips.map(c => (
						<button
							key={c.id}
							type="button"
							className={`gui-skill-market-chip${level === c.id ? " gui-skill-market-chip--on" : ""}`}
							onClick={() => setLevel(c.id)}
						>
							{c.label}
						</button>
					))}
				</div>

				{error && <div className="gui-ext-plugins-error">{error}</div>}

				{/* 标题行:`全部技能 · N` + 网格/列表切换。 */}
				<div className="gui-cap-row">
					<span className="gui-cap-row-title">{t("skill all title")}</span>
					<span className="gui-cap-row-count">· {filtered.length}</span>
					<div className="gui-cap-viewtoggle">
						<button
							type="button"
							className={`gui-cap-viewbtn${view === "grid" ? " gui-cap-viewbtn--on" : ""}`}
							aria-label={t("skill view grid")}
							aria-pressed={view === "grid"}
							onClick={() => setView("grid")}
						>
							<Icon name="split-cells-horizontal" className="h-4 w-4" />
						</button>
						<button
							type="button"
							className={`gui-cap-viewbtn${view === "list" ? " gui-cap-viewbtn--on" : ""}`}
							aria-label={t("skill view list")}
							aria-pressed={view === "list"}
							onClick={() => setView("list")}
						>
							<Icon name="list-check-2" className="h-4 w-4" />
						</button>
					</div>
				</div>

				<div className="gui-cap-grid-wrap">
					{skills === null ? (
						<div className="gui-cap-empty">{t("skill market loading")}</div>
					) : filtered.length === 0 ? (
						<div className="gui-cap-empty">
							<Icon name="star" className="h-5 w-5 opacity-50" />
							<div>{t("no skills installed")}</div>
							<div className="gui-cap-empty-hint">{t("install one from git or the marketplace")}</div>
							<button type="button" className="gui-btn" onClick={onAcquire}>
								<Icon name="download" className="h-3.5 w-3.5" />
								{t("acquire capabilities")}
							</button>
						</div>
					) : view === "grid" ? (
						<div className="gui-cap-grid">
							{filtered.map(s => {
								const picked = selected.has(s.name);
								return (
									<div
										key={s.name}
										role="button"
										tabIndex={0}
										className={`gui-cap-card${picked ? " gui-cap-card--picked" : ""}${s.ignored ? " gui-cap-card--off" : ""}`}
										onClick={() => (manage ? toggleSelected(s.name) : setDrawerName(s.name))}
										onKeyDown={e => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												if (manage) toggleSelected(s.name);
												else setDrawerName(s.name);
											}
										}}
									>
										{manage && (
											<span className={`gui-cap-pick${picked ? " gui-cap-pick--on" : ""}`} aria-hidden>
												{picked && <Icon name="check" className="h-3 w-3" />}
											</span>
										)}
										<div className="gui-cap-card-top">
											<SkillGlyph skill={s} size={30} />
											<span className="gui-cap-card-name">{s.name}</span>
											<button
												type="button"
												className="gui-cap-card-menu"
												aria-label={t("skill row actions")}
												onClick={e => {
													e.stopPropagation();
													setDrawerName(s.name);
												}}
											>
												<Icon name="more-2" className="h-3.5 w-3.5" />
											</button>
										</div>
										<div className="gui-cap-card-desc">{s.description || "—"}</div>
										<div className="gui-cap-card-meta">
											{skillLevelLabel(s)} · {skillOriginLabel(s)} · {skillVersionLabel(s)}
										</div>
										<div className="gui-cap-card-foot">
											{s.ignored ? (
												<span className="gui-ext-item-tag gui-ext-item-tag--err">
													{t("skill disabled")}
												</span>
											) : (
												<span className="gui-ext-item-tag gui-ext-item-tag--gui">{t("skill enabled")}</span>
											)}
											{!uninstallable(s) &&
												skillLevel(s) === "builtin" &&
												s.source.startsWith("managed") && (
													<span className="gui-cap-card-note">{t("skill bundled no uninstall")}</span>
												)}
										</div>
									</div>
								);
							})}
						</div>
					) : (
						<div className="gui-cap-list">
							{filtered.map(s => {
								const picked = selected.has(s.name);
								return (
									<div
										key={s.name}
										role="button"
										tabIndex={0}
										className={`gui-cap-listrow${picked ? " gui-cap-card--picked" : ""}`}
										onClick={() => (manage ? toggleSelected(s.name) : setDrawerName(s.name))}
										onKeyDown={e => {
											if (e.key === "Enter" || e.key === " ") {
												e.preventDefault();
												if (manage) toggleSelected(s.name);
												else setDrawerName(s.name);
											}
										}}
									>
										{manage && (
											<span className={`gui-cap-pick${picked ? " gui-cap-pick--on" : ""}`} aria-hidden>
												{picked && <Icon name="check" className="h-3 w-3" />}
											</span>
										)}
										<SkillGlyph skill={s} size={24} />
										<span className="gui-cap-listrow-name">{s.name}</span>
										<span className="gui-cap-listrow-desc">{s.description || "—"}</span>
										<span className="gui-cap-listrow-meta">
											{skillLevelLabel(s)} · {skillOriginLabel(s)}
										</span>
										{s.ignored && (
											<span className="gui-ext-item-tag gui-ext-item-tag--err">{t("skill disabled")}</span>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* 底部批量操作条 (设计稿 2:250):仅批量管理开启时出现。 */}
				{manage && (
					<div className="gui-cap-batch">
						<span className="gui-cap-batch-info">
							{selected.size > 0 ? (
								<>
									<Icon name="checkbox-circle" className="h-3.5 w-3.5" />
									{t("skill selected {n}", { n: selected.size })}
									<span className="gui-cap-batch-sep">·</span>
									{t("skill total hint {total}", { total: counts.total })}
									<span className="gui-cap-batch-sep">·</span>
									{t("skill batch hint")}
								</>
							) : (
								<>
									<Icon name="checkbox-blank" className="h-3.5 w-3.5" />
									{t("skill total hint {total}", { total: counts.total })}
									<span className="gui-cap-batch-sep">·</span>
									{t("skill batch hint")}
								</>
							)}
						</span>
						<div className="gui-cap-batch-actions">
							<button
								type="button"
								className="gui-btn"
								disabled={filtered.length === 0}
								onClick={() => setSelected(allSelected ? new Set() : new Set(filtered.map(s => s.name)))}
							>
								{t("skill select all")}
							</button>
							<button
								type="button"
								className="gui-btn gui-cap-uninstall"
								disabled={busy || selectedUninstallable === 0}
								onClick={() => void uninstallSelected()}
							>
								{t("uninstall")}
							</button>
							<button
								type="button"
								className="gui-btn"
								disabled={busy || selected.size === 0}
								onClick={() => void setIgnoredBatch([...selected], true)}
							>
								{t("skill batch disable")}
							</button>
							<button
								type="button"
								className="gui-btn gui-cap-batch-primary"
								disabled={busy || selected.size === 0}
								onClick={() => void setIgnoredBatch([...selected], false)}
							>
								{t("skill batch enable")}
							</button>
						</div>
					</div>
				)}

				{/* 贴底状态条 —— 与"发现"页同一条线索 (设计稿 2:250 页脚)。 */}
				<div className="gui-skill-market-status">
					{t("installed skills status {enabled} {disabled} {total}", {
						enabled: counts.total - counts.disabled,
						disabled: counts.disabled,
						total: counts.total,
					})}
				</div>

				{rpc && drawer && (
					<SkillDrawer
						rpc={rpc}
						skill={drawer}
						onClose={() => setDrawerName(null)}
						onChanged={reload}
						onDeleted={name =>
							setSelected(prev => {
								const next = new Set(prev);
								next.delete(name);
								return next;
							})
						}
					/>
				)}
			</div>
		</div>
	);
}

export function CapabilityCenter({ rpc }: { rpc: RpcClient | null }): ReactNode {
	const [screen, setScreen] = useState<"installed" | "acquire">("installed");

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

	if (screen === "acquire") {
		return (
			<div className="gui-cap">
				<div className="gui-cap-head">
					<button type="button" className="gui-cap-back" onClick={() => setScreen("installed")}>
						<StateIcon on={false} pair={["arrow-right-s", "arrow-left-s"]} className="h-4 w-4" />
						{t("installed capabilities")}
					</button>
					<div className="gui-cap-head-title">{t("acquire capabilities")}</div>
				</div>
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
			</div>
		);
	}

	return (
		<div className="gui-cap">
			<InstalledSkillsPane rpc={rpc} onAcquire={() => setScreen("acquire")} />
		</div>
	);
}

export { DiagnosticsView };
