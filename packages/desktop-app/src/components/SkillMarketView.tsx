import { t } from "@musepi/guest-client";
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
 * skills.sh contributes search hits only. Nothing here needs a registry
 * entry, which is why this view is NOT `MarketplaceGrid` (that one serves
 * user-added *plugin* sources and renders empty until a user registers one).
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
	const [addOpen, setAddOpen] = useState(false);

	const [pageData, setPageData] = useState<MarketPage | null>(null);
	const [featured, setFeatured] = useState<SkillEntry[]>([]);
	const [categories, setCategories] = useState<SkillCategory[]>([]);
	const [loading, setLoading] = useState(false);
	const [loadError, setLoadError] = useState<string | null>(null);
	// 底部状态栏 (设计稿 01): 已启用 / 已停用 / 来源市场数。
	const [installed, setInstalled] = useState({ enabled: 0, disabled: 0 });
	// 换一批 rotates the featured window: the daemon returns a ranked list
	// and the UI shows FEATURED_SIZE of it starting at this offset.
	const [featuredOffset, setFeaturedOffset] = useState(0);

	const refreshInstalled = useCallback((): void => {
		if (!rpc) return;
		void rpc
			.request<{ skills: { disabled?: boolean }[] }>("skills.list", {})
			.then(res => {
				const rows = res?.skills ?? [];
				setInstalled({
					enabled: rows.filter(s => !s.disabled).length,
					disabled: rows.filter(s => s.disabled).length,
				});
			})
			.catch(() => {});
	}, [rpc]);

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
				<button type="button" className="gui-skill-market-add" onClick={() => setAddOpen(true)}>
					<Icon name="add" className="h-3.5 w-3.5 shrink-0" />
					{t("add skill")}
				</button>
			</div>

			{failures ? <div className="gui-skill-market-warn">{t("skill market offline", { msg: failures })}</div> : null}
			{loadError ? <div className="gui-skill-market-warn">{loadError}</div> : null}

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
							<FeaturedCard key={e.id} entry={e} onOpen={() => setAddOpen(true)} />
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
								["all", t("skill market source skillhub")],
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
					<div className="gui-skill-market-note">{t("skill market empty")}</div>
				) : (
					<div className="gui-skill-market-grid">
						{entries.map(e => (
							<SkillCard key={e.id} entry={e} onOpen={() => setAddOpen(true)} />
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

			{addOpen ? (
				<AddSkillDialog rpc={rpc} onClose={() => setAddOpen(false)} onDone={() => onInstalled?.()} />
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

function FeaturedCard({ entry, onOpen }: { entry: SkillEntry; onOpen(): void }): ReactNode {
	return (
		<article className="gui-skill-market-fcard">
			<button type="button" className="gui-skill-market-plus" title={t("add skill")} onClick={onOpen}>
				<Icon name="add" className="h-3.5 w-3.5" />
			</button>
			<div className="gui-skill-market-fcard-h">
				<SkillGlyph entry={entry} />
				<span className="gui-skill-market-fcard-name">{entry.name}</span>
			</div>
			<p className="gui-skill-market-fcard-desc">{entry.descriptionZh || entry.description}</p>
		</article>
	);
}

function SkillCard({ entry, onOpen }: { entry: SkillEntry; onOpen(): void }): ReactNode {
	const meta: string[] = [];
	if (typeof entry.stars === "number") meta.push(`★ ${fmtCount(entry.stars)}`);
	if (typeof entry.downloads === "number") meta.push(`↓ ${fmtCount(entry.downloads)}`);
	if (entry.version) meta.push(`v${entry.version}`);
	return (
		<article className="gui-skill-market-card">
			<button type="button" className="gui-skill-market-plus" title={t("add skill")} onClick={onOpen}>
				<Icon name="add" className="h-3.5 w-3.5" />
			</button>
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
 * 「+ 添加技能」与卡片上的 `+` 共用这一个对话框 (设计稿 01 的按钮落点):
 * 两条路径都要落进 `~/.musepi/skills/<slug>/`,所以入口不同、动作同源。
 * 目录来源二选一 —— 直接填 skillhub slug,或给一个 Git 仓库地址。
 */
function AddSkillDialog({
	rpc,
	onClose,
	onDone,
}: {
	rpc: RpcClient | null;
	onClose(): void;
	onDone(): void;
}): ReactNode {
	const [tab, setTab] = useState<"skillhub" | "git">("skillhub");
	const [value, setValue] = useState("");
	const [busy, setBusy] = useState(false);
	const [err, setErr] = useState<string | null>(null);

	const submit = (): void => {
		if (!rpc || !value.trim()) return;
		setBusy(true);
		setErr(null);
		const params = tab === "skillhub" ? { slug: value.trim() } : { url: value.trim() };
		void rpc
			.request("skills.install", params)
			.then(() => {
				onDone();
				onClose();
			})
			.catch((e: unknown) => {
				setErr(e instanceof Error ? e.message : String(e));
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
				<div className="gui-capability-subtabs">
					{(
						[
							["skillhub", t("skill market source skillhub")],
							["git", t("skill market add git")],
						] as ["skillhub" | "git", string][]
					).map(([id, label]) => (
						<button
							key={id}
							type="button"
							className={`gui-capability-subtab${tab === id ? " gui-capability-subtab--on" : ""}`}
							onClick={() => setTab(id)}
						>
							{label}
						</button>
					))}
				</div>
				<input
					className="gui-skill-market-dialog-input"
					value={value}
					autoFocus
					placeholder={tab === "skillhub" ? t("skill market add slug") : t("skill market add url")}
					onChange={ev => setValue(ev.target.value)}
					onKeyDown={ev => {
						if (ev.key === "Enter") submit();
						if (ev.key === "Escape") onClose();
					}}
				/>
				{err ? <div className="gui-skill-market-warn">{err}</div> : null}
				<div className="gui-skill-market-dialog-f">
					<button type="button" className="gui-skill-market-page" onClick={onClose}>
						{t("cancel")}
					</button>
					<button type="button" className="gui-skill-market-add" disabled={busy || !value.trim()} onClick={submit}>
						{busy ? t("skill market loading") : t("add skill")}
					</button>
				</div>
			</div>
		</div>
	);
}
