import { t } from "@musepi/client-core";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { RpcClient } from "../lib/rpc";
import { Icon } from "../vendor/oc-icons";
import { GuiSelect } from "./GuiSelect";

/**
 * 技能市场 · 发现 (capability center → 技能 tab, 设计稿 frame 01).
 *
 * Reads the remote catalog through the four `skills.marketplace.*` RPCs —
 * SkillHub is the primary source (icons, stars, downloads, categories) and
 * skills.sh contributes search hits with a GitHub `installUrl` each. Card
 * actions route by what the entry carries:
 *
 *   - skills.sh entry (installUrl present) → one click runs
 *     `skills.install {url}` straight from the card;
 *   - SkillHub entry (no git source exposed) → opens the add dialog
 *     prefilled with the catalog homepage so the user confirms/edits the
 *     source before installing.
 *
 * Nothing here needs a registry entry, which is why this view is NOT
 * `MarketplaceGrid` (that one serves user-added *plugin* sources and
 * renders empty until a user registers one).
 *
 * Failure model: a dead catalog surfaces as a non-blocking banner; the
 * surviving half still renders. See `skills/marketplace-client.ts`.
 */

interface SkillEntry {
	id: string;
	source: "skillhub" | "skills.sh";
	slug: string;
	name: string;
	description: string;
	descriptionZh?: string;
	author?: string;
	category?: string;
	iconUrl?: string;
	stars?: number;
	downloads?: number;
	installs?: number;
	version?: string;
	homepage?: string;
	verified?: boolean;
	installUrl?: string;
	/** skills.sh: publisher repo (`owner/repo`); slug is the repo-relative folder. */
	repo?: string;
}

interface SkillCategory {
	key: string;
	name: string;
	nameEn?: string;
}

interface MarketPage {
	entries: SkillEntry[];
	total: number;
	liveSources: string[];
	failures: string[];
}

type SourceFilter = "all" | "skillhub" | "skills.sh";
type SortKey = "downloads" | "stars" | "installs";

const PAGE_SIZE = 12;
const FEATURED_SIZE = 4;

/** Compact 1,284-style number for the result-count line. */
function fmtCount(n: number): string {
	if (!Number.isFinite(n)) return "0";
	return n.toLocaleString("en-US");
}

export function SkillMarketView({ rpc, onInstalled }: { rpc: RpcClient | null; onInstalled?(): void }): ReactNode {
	const [source, setSource] = useState<SourceFilter>("all");
	const [category, setCategory] = useState<string>("");
	const [sortBy, setSortBy] = useState<SortKey>("downloads");
	const [keyword, setKeyword] = useState("");
	const [page, setPage] = useState(1);
	// null = 关闭;对象 = 打开对话框并预填(卡片带入目录来源,裸按钮空表)。
	const [addPrefill, setAddPrefill] = useState<{ url?: string; name?: string } | null>(null);
	// 卡片点击预览（信息先览，再决定安装）——与 addPrefill 互斥的两层弹窗。
	const [previewEntry, setPreviewEntry] = useState<SkillEntry | null>(null);

	const [pageData, setPageData] = useState<MarketPage | null>(null);
	const [featured, setFeatured] = useState<SkillEntry[]>([]);
	const [categories, setCategories] = useState<SkillCategory[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	// 底部状态栏 (设计稿 01): 已启用 / 已停用 / 来源市场数;installedNames
	// 同时驱动卡片上的「已安装」态 —— 装完即回读,不用等重新挂载。
	const [installed, setInstalled] = useState({ enabled: 0, disabled: 0 });
	const [installedNames, setInstalledNames] = useState<Set<string>>(new Set());
	// 一键安装的去重 + 结果反馈:busyId 锁卡片,notice 是顶部非阻塞提示条
	// (成功 2.5s 自动消退,失败驻留到下一次操作)。
	const [busyId, setBusyId] = useState<string | null>(null);
	const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
	// 换一批 rotates the featured window: the daemon returns a ranked list
	// and the UI shows FEATURED_SIZE of it starting at this offset.
	const [featuredOffset, setFeaturedOffset] = useState(0);

	const refreshInstalled = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ skills: { name?: string; disabled?: boolean }[] }>("skills.list", {})
			.then(res => {
				const rows = res?.skills ?? [];
				setInstalled({
					enabled: rows.filter(s => !s.disabled).length,
					disabled: rows.filter(s => s.disabled).length,
				});
				setInstalledNames(new Set(rows.map(s => (s.name ?? "").toLowerCase()).filter(Boolean)));
			})
			.catch(() => {});
	}, [rpc]);

	// 成功提示自动消退;失败提示驻留(用户需要读完原因)。
	useEffect(() => {
		if (!notice?.ok) return;
		const id = window.setTimeout(() => setNotice(null), 2500);
		return () => window.clearTimeout(id);
	}, [notice]);

	// Categories + featured load once; they are catalog-level, not query-level.
	useEffect(() => {
		refreshInstalled();
	}, [refreshInstalled]);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ categories: SkillCategory[] }>("skills.marketplace.categories", {})
			.then(res => alive && setCategories(res?.categories ?? []))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		void rpc
			.request<{ entries: SkillEntry[] }>("skills.marketplace.featured", { pageSize: FEATURED_SIZE * 4 })
			.then(res => alive && setFeatured(res?.entries ?? []))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [rpc]);

	// The grid query. Any filter change resets paging to 1 — keeping the old
	// page would silently show an out-of-range (empty) window.
	const load = useCallback((): void => {
		if (!rpc) return;
		setLoading(true);
		void rpc
			.request<MarketPage>("skills.marketplace.query", {
				keyword: keyword.trim() || undefined,
				category: category || undefined,
				sources: source === "all" ? undefined : [source],
				sortBy,
				pageSize: PAGE_SIZE,
				page,
			})
			.then(res => {
				setPageData(res ?? null);
				setLoadError(null);
			})
			.catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
			.finally(() => setLoading(false));
	}, [rpc, keyword, category, source, sortBy, page]);

	useEffect(() => {
		// Debounce the keyword so typing does not fire one RPC per keystroke.
		const id = setTimeout(load, 250);
		return () => clearTimeout(id);
	}, [load]);

	const entries = pageData?.entries ?? [];
	const total = pageData?.total ?? 0;
	const failures = useMemo(() => {
		const all = [...(pageData?.failures ?? [])];
		return all.length > 0 ? all.join(" · ") : null;
	}, [pageData]);
	const shownFeatured = useMemo(
		() => featured.slice(featuredOffset, featuredOffset + FEATURED_SIZE),
		[featured, featuredOffset],
	);
	const hasMore = page * PAGE_SIZE < total;
	const maxPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

	/**
	 * 一键安装 —— 走 `skills.marketplace.install` 的来源感知路由：
	 * SkillHub 由 daemon 下载官方 zip（302 → 对象存储）解压安装，不再把
	 * 目录主页当 git URL clone（403 旧案）；skills.sh 以 repo+slug 走
	 * 子目录 git 安装（skill id 即仓库内文件夹）。装完回读 skills.list，
	 * 卡片就地翻「已安装」,父级同步「我安装的 N」计数。
	 */
	const installEntry = useCallback(
		(entry: SkillEntry): void => {
			if (!rpc || busyId) return;
			if (entry.source === "skills.sh" && !entry.repo) {
				setNotice({
					ok: false,
					text: t("skill market install failed {name}", { name: entry.name, msg: "no repo" }),
				});
				return;
			}
			setBusyId(entry.id);
			setNotice(null);
			void rpc
				.request<{ ok: boolean; name: string }>("skills.marketplace.install", {
					source: entry.source,
					slug: entry.slug,
					...(entry.repo ? { repo: entry.repo } : {}),
				})
				.then(res => {
					setNotice({ ok: true, text: t("skill installed {name}", { name: res?.name ?? entry.name }) });
					refreshInstalled();
					onInstalled?.();
				})
				.catch((e: unknown) => {
					const msg = e instanceof Error ? e.message : String(e);
					setNotice({ ok: false, text: t("skill market install failed {name}", { name: entry.name, msg }) });
				})
				.finally(() => setBusyId(null));
		},
		[rpc, busyId, refreshInstalled, onInstalled],
	);

	const isInstalled = useCallback(
		(entry: SkillEntry): boolean => installedNames.has(entry.name.toLowerCase()),
		[installedNames],
	);

	return (
		<div className="gui-skill-market">
			{/* 工具行 (设计稿 01):搜索 → 全部来源下拉 → 热门优先下拉 → + 添加技能 */}
			<div className="gui-skill-market-bar">
				<label className="gui-skill-market-search">
					<Icon name="search" className="h-3.5 w-3.5 shrink-0 opacity-60" />
					<input
						type="search"
						value={keyword}
						placeholder={t("skill market search")}
						onChange={ev => {
							setKeyword(ev.target.value);
							setPage(1);
						}}
					/>
				</label>
				{/* Frosted GuiSelect (规范下拉): replaces the native <select>. */}
				<GuiSelect<SourceFilter>
					value={source}
					onChange={v => {
						setSource(v);
						setPage(1);
					}}
					ariaLabel={t("skill market source")}
					options={[
						{ value: "all", label: t("skill market source all") },
						{ value: "skillhub", label: t("skill market source skillhub") },
						{ value: "skills.sh", label: t("skill market source skills.sh") },
					]}
				/>
				<GuiSelect<SortKey>
					value={sortBy}
					onChange={v => {
						setSortBy(v);
						setPage(1);
					}}
					ariaLabel={t("skill market sort")}
					options={[
						{ value: "downloads", label: t("skill market sort downloads") },
						{ value: "stars", label: t("skill market sort stars") },
						{ value: "installs", label: t("skill market sort installs") },
					]}
				/>
				<button type="button" className="gui-skill-market-add" onClick={() => setAddPrefill({})}>
					<Icon name="add" className="h-3.5 w-3.5 shrink-0" />
					{t("add skill")}
				</button>
			</div>

			{failures ? <div className="gui-skill-market-warn">{t("skill market offline", { msg: failures })}</div> : null}
			{loadError ? <div className="gui-skill-market-warn">{loadError}</div> : null}
			{notice && (
				<div
					className={`gui-skill-market-note${notice.ok ? " gui-skill-market-note--ok" : " gui-skill-market-note--err"}`}
				>
					{notice.text}
				</div>
			)}

			{shownFeatured.length > 0 ? (
				<section className="gui-skill-market-section">
					<div className="gui-skill-market-section-h">
						<Icon name="sparkling" className="h-3.5 w-3.5 shrink-0 text-[var(--color-accent)]" />
						<span className="gui-skill-market-section-title">{t("skill market featured")}</span>
						<button
							type="button"
							className="gui-skill-market-link"
							onClick={() => setFeaturedOffset(o => (o + FEATURED_SIZE) % Math.max(featured.length, 1))}
						>
							{t("skill market shuffle")}
						</button>
					</div>
					<div className="gui-skill-market-featured">
						{shownFeatured.map(e => (
							<FeaturedCard
								key={e.id}
								entry={e}
								installed={isInstalled(e)}
								busy={busyId === e.id}
								onInstall={() => installEntry(e)}
								onOpen={() => setPreviewEntry(e)}
							/>
						))}
					</div>
				</section>
			) : null}

			<section className="gui-skill-market-section">
				{/* 推荐套件行:左侧来源 pill,右侧 来自 N 个市场 · 共 M 个技能 */}
				<div className="gui-skill-market-section-h">
					<span className="gui-skill-market-section-title">{t("skill market recommended")}</span>
					<div className="gui-skill-market-pills">
						{(
							[
								["all", t("skill market source all")],
								["skillhub", t("skill market source skillhub")],
								["skills.sh", t("skill market source skills.sh")],
							] as [SourceFilter, string][]
						).map(([id, label]) => (
							<button
								key={id}
								type="button"
								className={`gui-skill-market-pill${source === id ? " gui-skill-market-pill--on" : ""}`}
								onClick={() => {
									setSource(id);
									setPage(1);
								}}
							>
								{label}
							</button>
						))}
					</div>
					<span className="gui-skill-market-count">
						{t("skill market summary", {
							sources: String(pageData?.liveSources?.length ?? 0),
							total: fmtCount(total),
						})}
					</span>
				</div>
				<div className="gui-skill-market-chips">
					<button
						type="button"
						className={`gui-skill-market-chip${category === "" ? " gui-skill-market-chip--on" : ""}`}
						onClick={() => {
							setCategory("");
							setPage(1);
						}}
					>
						{t("skill market all categories")}
					</button>
					{categories.map(c => (
						<button
							key={c.key}
							type="button"
							className={`gui-skill-market-chip${category === c.key ? " gui-skill-market-chip--on" : ""}`}
							onClick={() => {
								setCategory(c.key);
								setPage(1);
							}}
						>
							{c.name}
						</button>
					))}
				</div>
				{entries.length === 0 && !loading ? (
					source === "skills.sh" && !keyword.trim() ? (
						<div className="gui-skill-market-note">{t("skill market search skills.sh hint")}</div>
					) : (
						<div className="gui-skill-market-note">{t("skill market empty")}</div>
					)
				) : (
					<div className="gui-skill-market-grid">
						{entries.map(e => (
							<SkillCard
								key={e.id}
								entry={e}
								installed={isInstalled(e)}
								busy={busyId === e.id}
								onInstall={() => installEntry(e)}
								onOpen={() => setPreviewEntry(e)}
							/>
						))}
					</div>
				)}
				{maxPage > 1 ? (
					<div className="gui-skill-market-pager">
						<button
							type="button"
							className="gui-skill-market-page"
							disabled={page <= 1}
							onClick={() => setPage(p => Math.max(1, p - 1))}
						>
							{t("prev page")}
						</button>
						<span className="gui-skill-market-page-n">
							{page} / {maxPage}
						</span>
						<button
							type="button"
							className="gui-skill-market-page"
							disabled={!hasMore}
							onClick={() => setPage(p => p + 1)}
						>
							{t("next page")}
						</button>
					</div>
				) : null}
			</section>

			{/* 底部状态栏 (设计稿 01):已启用 N · 已停用 M · 来源 K 个市场 */}
			<div className="gui-skill-market-status">
				{t("skill market status", {
					enabled: String(installed.enabled),
					disabled: String(installed.disabled),
					sources: String(pageData?.liveSources?.length ?? 0),
				})}
			</div>

			{addPrefill ? (
				<AddSkillDialog
					rpc={rpc}
					initialUrl={addPrefill.url ?? ""}
					initialName={addPrefill.name ?? ""}
					onClose={() => setAddPrefill(null)}
					onDone={name => {
						setNotice({ ok: true, text: t("skill installed {name}", { name }) });
						refreshInstalled();
						onInstalled?.();
					}}
				/>
			) : null}
			{previewEntry ? (
				<SkillPreviewDialog
					rpc={rpc}
					entry={previewEntry}
					installed={isInstalled(previewEntry)}
					busy={busyId === previewEntry.id}
					onInstall={() => installEntry(previewEntry)}
					onClose={() => setPreviewEntry(null)}
				/>
			) : null}
		</div>
	);
}

/** Colored initial tile: the catalogs ship icons for some skills only, and a
 *  missing remote image must not leave an empty hole in the card. */
function SkillGlyph({ entry }: { entry: SkillEntry }): ReactNode {
	const [broken, setBroken] = useState(false);
	if (entry.iconUrl && !broken) {
		return (
			<img
				className="gui-skill-market-glyph"
				src={entry.iconUrl}
				alt=""
				loading="lazy"
				onError={() => setBroken(true)}
			/>
		);
	}
	const hue = (entry.slug.charCodeAt(0) * 37) % 360;
	return (
		<span
			className="gui-skill-market-glyph gui-skill-market-glyph--fallback"
			style={{ background: `oklch(0.28 0.06 ${hue})` }}
		>
			{entry.name.slice(0, 1)}
		</span>
	);
}

/**
 * 卡片右上角的动作角标,三个状态互斥:
 *   已安装 → 绿色对勾,不可再点;
 *   安装中 → 转圈,锁定防重复提交;
 *   可安装 → 有 installUrl(skills.sh 带 GitHub 源)一键装,没有
 *   (SkillHub 目录项)打开预填对话框让用户确认来源后再装。
 */
function CardAddButton({
	entry,
	installed,
	busy,
	onInstall,
	onOpen,
}: {
	entry: SkillEntry;
	installed: boolean;
	busy: boolean;
	onInstall(): void;
	onOpen(): void;
}): ReactNode {
	if (installed) {
		return (
			<button
				type="button"
				className="gui-skill-market-plus gui-skill-market-plus--done"
				disabled
				title={t("skill market installed")}
			>
				<Icon name="check" className="h-3.5 w-3.5" />
			</button>
		);
	}
	if (busy) {
		return (
			<button type="button" className="gui-skill-market-plus" disabled title={t("installing")}>
				<Icon name="loader" className="gui-skill-market-plus-spin h-3.5 w-3.5" />
			</button>
		);
	}
	return (
		<button
			type="button"
			className="gui-skill-market-plus"
			title={t("add skill")}
			onClick={ev => {
				// 角标动作不冒泡到卡片主体的预览点击。
				ev.stopPropagation();
				if (entry.installUrl || entry.source) onInstall();
				else onOpen();
			}}
		>
			<Icon name="add" className="h-3.5 w-3.5" />
		</button>
	);
}

function FeaturedCard({
	entry,
	installed,
	busy,
	onInstall,
	onOpen,
}: {
	entry: SkillEntry;
	installed: boolean;
	busy: boolean;
	onInstall(): void;
	onOpen(): void;
}): ReactNode {
	return (
		<article
			className="gui-skill-market-fcard gui-skill-market-clickable"
			onClick={onOpen}
			title={entry.descriptionZh || entry.description || entry.name}
		>
			<CardAddButton entry={entry} installed={installed} busy={busy} onInstall={onInstall} onOpen={onOpen} />
			<div className="gui-skill-market-fcard-h">
				<SkillGlyph entry={entry} />
				<span className="gui-skill-market-fcard-name">{entry.name}</span>
			</div>
			<p className="gui-skill-market-fcard-desc">{entry.descriptionZh || entry.description}</p>
			{entry.author ? <footer className="gui-skill-market-meta">{entry.author}</footer> : null}
		</article>
	);
}

function SkillCard({
	entry,
	installed,
	busy,
	onInstall,
	onOpen,
}: {
	entry: SkillEntry;
	installed: boolean;
	busy: boolean;
	onInstall(): void;
	onOpen(): void;
}): ReactNode {
	const meta: string[] = [];
	if (entry.author) meta.push(entry.author);
	if (typeof entry.stars === "number") meta.push(`★ ${fmtCount(entry.stars)}`);
	if (typeof entry.downloads === "number") meta.push(`↓ ${fmtCount(entry.downloads)}`);
	if (typeof entry.installs === "number" && !entry.downloads) meta.push(`↓ ${fmtCount(entry.installs)}`);
	if (entry.version) meta.push(`v${entry.version}`);
	return (
		<article
			className="gui-skill-market-card gui-skill-market-clickable"
			onClick={onOpen}
			title={entry.descriptionZh || entry.description || entry.name}
		>
			<CardAddButton entry={entry} installed={installed} busy={busy} onInstall={onInstall} onOpen={onOpen} />
			<div className="gui-skill-market-card-h">
				<SkillGlyph entry={entry} />
				<span className="gui-skill-market-card-name">{entry.name}</span>
				{entry.verified ? <span className="gui-skill-market-badge">{t("skill market verified")}</span> : null}
			</div>
			<p className="gui-skill-market-card-desc">{entry.descriptionZh || entry.description}</p>
			<footer className="gui-skill-market-card-f">
				<span className="gui-skill-market-meta">{meta.join(" · ")}</span>
			</footer>
		</article>
	);
}

/**
 * 「+ 添加技能」对话框 (设计稿 01 的按钮落点):卡片没有可直接安装的
 * 来源(Git URL)时在此确认/编辑后走 `skills.install` —— 与 TUI 扩展
 * 中心的「从 Git 安装」同一条 daemon 契约 `{url, name?, overwrite?}`。
 * 卡片有 installUrl 时不经过这里,角标一键安装。名称冲突不是死错误:
 * 就地给出「覆盖安装」重试(GitInstallCard 同款动线)。
 */
function AddSkillDialog({
	rpc,
	initialUrl,
	initialName,
	onClose,
	onDone,
}: {
	rpc: RpcClient | null;
	initialUrl: string;
	initialName: string;
	onClose(): void;
	onDone(name: string): void;
}): ReactNode {
	const [url, setUrl] = useState(initialUrl);
	const [name, setName] = useState(initialName);
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<{ text: string; canOverwrite: boolean } | null>(null);

	const install = (overwrite: boolean): void => {
		if (!rpc || !url.trim() || busy) return;
		setBusy(true);
		setErr(null);
		void rpc
			.request<{ ok: boolean; name: string }>("skills.install", {
				url: url.trim(),
				...(name.trim() ? { name: name.trim() } : {}),
				...(overwrite ? { overwrite: true } : {}),
			})
			.then(res => {
				onDone(res?.name ?? (name.trim() || url.trim()));
				onClose();
			})
			.catch((e: unknown) => {
				const text = e instanceof Error ? e.message : String(e);
				setErr({ text, canOverwrite: /exist|conflict|overwrite/i.test(text) });
				setBusy(false);
			});
	};

	return (
		<div className="gui-skill-market-dialog-backdrop" role="presentation" onClick={onClose}>
			<div
				className="gui-skill-market-dialog"
				role="dialog"
				aria-label={t("add skill")}
				onClick={ev => ev.stopPropagation()}
			>
				<div className="gui-skill-market-dialog-h">{t("add skill")}</div>
				<input
					className="gui-skill-market-dialog-input"
					value={url}
					autoFocus
					spellCheck={false}
					placeholder={t("skill market add url")}
					onChange={ev => setUrl(ev.target.value)}
					onKeyDown={ev => {
						if (ev.key === "Enter") install(false);
						if (ev.key === "Escape") onClose();
					}}
				/>
				<input
					className="gui-skill-market-dialog-input"
					value={name}
					spellCheck={false}
					placeholder={t("optional name override")}
					onChange={ev => setName(ev.target.value)}
					onKeyDown={ev => {
						if (ev.key === "Enter") install(false);
						if (ev.key === "Escape") onClose();
					}}
				/>
				{err ? <div className="gui-skill-market-warn">{err.text}</div> : null}
				<div className="gui-skill-market-dialog-f">
					{err?.canOverwrite && (
						<button type="button" className="gui-skill-market-page" disabled={busy} onClick={() => install(true)}>
							{t("overwrite install")}
						</button>
					)}
					<button type="button" className="gui-skill-market-page" onClick={onClose}>
						{t("cancel")}
					</button>
					<button
						type="button"
						className="gui-skill-market-add"
						disabled={busy || !url.trim()}
						onClick={() => install(false)}
					>
						{busy ? t("installing") : t("add skill")}
					</button>
				</div>
			</div>
		</div>
	);
}

/** 卡片点击的信息先览弹窗（液态玻璃 + spring 动效，样式见
 *  gui-workspace.css 的 gui-skill-market-dialog* 族）。两个来源各取所长：
 *  - skills.sh：daemon 从发布者仓库直读 SKILL.md 正文（搜索接口不带描述，
 *    正文预览补上「看不到内容」的缺口）；
 *  - SkillHub：详情 RPC（版本 + 文件清单 + 安全审计）。
 *  footer 的来源感知安装与卡片角标同一条 `skills.marketplace.install` 路由。 */
function SkillPreviewDialog({
	rpc,
	entry,
	installed,
	busy,
	onInstall,
	onClose,
}: {
	rpc: RpcClient | null;
	entry: SkillEntry;
	installed: boolean;
	busy: boolean;
	onInstall(): void;
	onClose(): void;
}): ReactNode {
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);
	const [markdown, setMarkdown] = useState<string | null>(null);
	const [detail, setDetail] = useState<{
		latestVersion?: string;
		files?: { path: string; size: number }[];
		security?: { status?: string; statusText?: string; reportUrl?: string }[];
	} | null>(null);

	useEffect(() => {
		if (!rpc) return;
		let alive = true;
		setLoading(true);
		setError(null);
		setMarkdown(null);
		setDetail(null);
		void rpc
			.request<{ content?: string | null; detail?: unknown }>("skills.marketplace.preview", {
				source: entry.source,
				slug: entry.slug,
				...(entry.repo ? { repo: entry.repo } : {}),
			})
			.then(res => {
				if (!alive) return;
				if (entry.source === "skills.sh") {
					setMarkdown(res?.content ?? null);
				} else {
					setDetail((res?.detail ?? null) as typeof detail);
				}
			})
			.catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
			.finally(() => alive && setLoading(false));
		return () => {
			alive = false;
		};
	}, [rpc, entry]);

	const meta: string[] = [];
	if (entry.author) meta.push(entry.author);
	if (typeof entry.stars === "number") meta.push(`★ ${fmtCount(entry.stars)}`);
	if (typeof entry.downloads === "number") meta.push(`↓ ${fmtCount(entry.downloads)}`);
	if (typeof entry.installs === "number" && !entry.downloads) meta.push(`↓ ${fmtCount(entry.installs)}`);

	return (
		<div
			className="gui-skill-market-dialog-backdrop"
			role="presentation"
			onClick={ev => {
				ev.stopPropagation();
				onClose();
			}}
		>
			<div
				className="gui-skill-market-dialog gui-skill-market-preview"
				role="dialog"
				aria-label={entry.name}
				onClick={ev => ev.stopPropagation()}
			>
				<div className="gui-skill-market-dialog-h gui-skill-market-preview-h">
					<SkillGlyph entry={entry} />
					<div className="gui-skill-market-preview-title">
						<span className="gui-skill-market-preview-name">{entry.name}</span>
						<span className="gui-skill-market-meta">
							{entry.source === "skillhub"
								? t("skill market source skillhub")
								: t("skill market source skills.sh")}
							{meta.length > 0 ? ` · ${meta.join(" · ")}` : ""}
						</span>
					</div>
					<button type="button" className="gui-skill-market-page" onClick={onClose} aria-label={t("close")}>
						✕
					</button>
				</div>

				<div className="gui-skill-market-preview-body">
					{entry.descriptionZh || entry.description ? (
						<p className="gui-skill-market-card-desc">{entry.descriptionZh || entry.description}</p>
					) : null}

					{loading ? <p className="gui-skill-market-note">{t("skill market preview loading")}</p> : null}
					{error ? <p className="gui-skill-market-warn">{error}</p> : null}

					{!loading && !error && entry.source === "skills.sh" ? (
						markdown ? (
							<pre className="gui-skill-market-preview-md">{markdown}</pre>
						) : (
							<p className="gui-skill-market-note">{t("skill market preview none")}</p>
						)
					) : null}

					{!loading && !error && entry.source === "skillhub" ? (
						detail ? (
							<div className="gui-skill-market-preview-detail">
								{detail.latestVersion ? (
									<p className="gui-skill-market-meta">
										{t("skill market preview version")} v{detail.latestVersion}
									</p>
								) : null}
								{detail.files && detail.files.length > 0 ? (
									<div className="gui-skill-market-preview-files">
										<p className="gui-skill-market-meta">
											{t("skill market preview files")} · {detail.files.length}
										</p>
										<ul>
											{detail.files.slice(0, 30).map(f => (
												<li key={f.path}>
													{f.path}
													{f.size > 0 ? ` (${f.size} B)` : ""}
												</li>
											))}
											{detail.files.length > 30 ? <li>…</li> : null}
										</ul>
									</div>
								) : null}
								{detail.security && detail.security.length > 0 ? (
									<div className="gui-skill-market-preview-files">
										<p className="gui-skill-market-meta">{t("skill market preview security")}</p>
										<ul>
											{detail.security.map((s, i) => (
												<li key={i}>
													{s.statusText ?? s.status ?? "?"}
													{s.reportUrl ? (
														<>
															{" · "}
															<a href={s.reportUrl} target="_blank" rel="noreferrer">
																{s.reportUrl}
															</a>
														</>
													) : null}
												</li>
											))}
										</ul>
									</div>
								) : null}
								{!detail.latestVersion && (!detail.files || detail.files.length === 0) ? (
									<p className="gui-skill-market-note">{t("skill market preview none")}</p>
								) : null}
							</div>
						) : (
							<p className="gui-skill-market-note">{t("skill market preview none")}</p>
						)
					) : null}
				</div>

				<div className="gui-skill-market-dialog-f">
					{entry.homepage ? (
						<a
							className="gui-skill-market-link"
							href={entry.homepage}
							target="_blank"
							rel="noreferrer"
							onClick={ev => ev.stopPropagation()}
						>
							{t("skill market homepage")}
						</a>
					) : null}
					<span className="gui-skill-market-flex" aria-hidden />
					{installed ? (
						<button type="button" className="gui-skill-market-add" disabled>
							<Icon name="check" className="h-3.5 w-3.5" /> {t("skill market installed")}
						</button>
					) : (
						<button
							type="button"
							className="gui-skill-market-add"
							disabled={busy}
							onClick={ev => {
								ev.stopPropagation();
								onInstall();
							}}
						>
							{busy ? t("installing") : t("skill market install")}
						</button>
					)}
				</div>
			</div>
		</div>
	);
}
