/*
 * Surface registry for the right toolbar/panel: each surface declares
 * id/label/icon/availability/defaultWidthFraction; the RightRail orders,
 * hides, and sizes the panel accordingly. Pure module data + persistence,
 * no React.
 */
import type { RpcClient } from "../rpc";

export type SurfaceAvailability = "always" | "has-content";
export type SurfaceId =
	| "context"
	| "files"
	| "artifacts"
	| "widget"
	| "trajectory"
	| "jobs"
	| "git"
	| "pr"
	| "diff"
	| "notes"
	| "browser"
	| (string & {}); // 扩展槽注入（panel.tab.* / rail.*）

export interface SurfaceProps {
	rpc: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
	/** Surfaces with open tabs (tab-primary model). Feeds the has-content
	 *  fallback: a has-content surface without its own predicate stays
	 *  visible while it has open tabs — a panel the user is working in must
	 *  not vanish on a state change. */
	openSurfaces?: ReadonlySet<string>;
}

export type SurfaceGroup = "primary" | "secondary" | "tertiary";

export interface SurfaceDescriptor {
	id: SurfaceId;
	/** i18n key（用 t() 取 display） */
	label: string;
	/** i18n key — rail hover tooltip 的第二行。省略时 tooltip 只显示 label。 */
	description?: string;
	/** oc-icons 的 IconName */
	icon: string;
	/** 分组：primary 显式图标、secondary 折叠菜单、tertiary 不占 rail */
	group: SurfaceGroup;
	/** has-content：仅在“有内容”时出现在 rail（如无 diff/PR 时隐藏） */
	availability: SurfaceAvailability;
	/** 面板默认宽度占比（0..1），起步宽由它决定 */
	defaultWidthFraction: number;
	/** 可选：是否有一个对应“是否有内容”的判定 */
	hasContent?(ctx: SurfaceProps): boolean;
	render?(rpc: RpcClient | null, props: SurfaceProps): unknown;
}

/* ── 内置 surface ─────────────────────────────────────────────── */
export const SURFACES: SurfaceDescriptor[] = [
	// Session views (formerly the panel header tabs) — VSCode Activity-Bar
	// unification: ONE rail drives the whole panel.
	{
		id: "context",
		label: "context",
		description: "surface description context",
		icon: "donut-chart",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	{
		id: "files",
		label: "files",
		description: "surface description files",
		icon: "folder",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	// Artifacts panel (设计板 W3): discovered artifact.manifest.json sidecars
	// in the workspace, with the entry-file viewer behind each card.
	{
		id: "artifacts",
		label: "artifacts",
		description: "surface description artifacts",
		icon: "stack",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.55,
	},
	{
		id: "trajectory",
		label: "trajectory",
		description: "surface description trajectory",
		icon: "list-unordered",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	{
		id: "jobs",
		label: "jobs",
		description: "surface description jobs",
		icon: "task",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	// Workbench tool panes.
	// Git is a single rail entry (Phase 3 merge): the panel opens with a
	// view-local sub-tab bar switching workspace changes / commit history /
	// pull requests (see GitPanel in ContextPanel). The old 3 independent
	// git/diff/pr surfaces are folded into it.
	{
		id: "git",
		label: "git",
		description: "surface description git",
		icon: "git-branch",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.55,
	},
	{
		id: "notes",
		label: "project knowledge",
		description: "surface description notes",
		icon: "book-open",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	{
		id: "browser",
		label: "browser",
		description: "surface description browser",
		icon: "global",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.6,
	},
	/* Agents hub (TUI Agent Hub parity): the session's roster; a swarm-card
	 * member row / roster row drills the trajectory detail into THIS view.
	 * Appended after the panes so the ⌘1..8 rail-order jump only shifts at
	 * the tail (widget preview folds into the rail overflow anyway). */
	{
		id: "agents",
		label: "agents",
		description: "surface description agents",
		icon: "ai-agent",
		group: "primary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	// Niche: widget preview folds into the overflow menu.
	{
		id: "widget",
		label: "widget preview",
		description: "surface description widget",
		icon: "sparkling",
		group: "secondary",
		availability: "always",
		defaultWidthFraction: 0.45,
	},
];

const byId = new Map<string, SurfaceDescriptor>(SURFACES.map(s => [s.id, s]));
export function surfaceById(id: string | null): SurfaceDescriptor | undefined {
	return id ? byId.get(id) : undefined;
}

/** 对于 has-content surface：有判定函数用它；否则退到"有打开的 tab 即可见"
 * —— 用户正在用的面板不因状态变化消失。 */
export function surfaceVisible(s: SurfaceDescriptor, ctx: SurfaceProps): boolean {
	if (s.availability === "always") return true;
	if (s.hasContent) return s.hasContent(ctx);
	return ctx.openSurfaces?.has(s.id) ?? false;
}

/* ── 持久化 ───────────────────────────────────────────────────── */
export const SURFACE_ORDER_KEY = "musepi-gui-right-order";
export const SURFACE_CTX_PREFIX = "musepi-gui-right-ctx-";
export const SURFACE_WIDTHS_KEY = "musepi-gui-right-widths";
export const SURFACE_HIDDEN_KEY = "musepi-gui-right-hidden";
/** @deprecated 按表面记忆宽度后不再使用；仅作首次迁移的回退源。 */
export const SURFACE_WIDTH_KEY = "musepi-gui-right-width";

/** 每表面宽度（px），200–1200 钳制；非法整体丢弃。 */
export function readSurfaceWidths(): Record<string, number> {
	try {
		const raw = localStorage.getItem(SURFACE_WIDTHS_KEY);
		if (!raw) return {};
		const parsed: unknown = JSON.parse(raw);
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
		const out: Record<string, number> = {};
		for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
			const px = Number(value);
			if (typeof id === "string" && id !== "" && Number.isFinite(px)) {
				out[id] = Math.min(1200, Math.max(200, Math.round(px)));
			}
		}
		return out;
	} catch {
		return {};
	}
}

function writeSurfaceWidths(widths: Record<string, number>): void {
	try {
		localStorage.setItem(SURFACE_WIDTHS_KEY, JSON.stringify(widths));
	} catch {
		/* ignore */
	}
}

function readLegacyGlobalWidth(): number | null {
	try {
		const raw = localStorage.getItem(SURFACE_WIDTH_KEY);
		if (raw === null || raw.trim() === "") return null;
		const n = Number(raw);
		if (!Number.isFinite(n)) return null;
		return Math.min(1200, Math.max(200, Math.round(n)));
	} catch {
		return null;
	}
}

/** 某表面的记忆宽度：map 命中 → 旧全局键回退 → 默认占比换算。 */
export function widthForSurface(id: string, defaultWidthFraction: number): number {
	const hit = readSurfaceWidths()[id];
	if (hit !== undefined) return hit;
	return readLegacyGlobalWidth() ?? Math.max(200, Math.min(1200, Math.round(defaultWidthFraction * 900)));
}

export function writeSurfaceWidth(id: string, px: number): void {
	if (!id) return;
	const widths = readSurfaceWidths();
	widths[id] = Math.min(1200, Math.max(200, Math.round(px)));
	writeSurfaceWidths(widths);
}

/** 用户隐藏的表面 id（rail 不渲染，⌘ 跳转跳过；面板已打开的不强制关闭）。 */
export function readHiddenSurfaces(): string[] {
	try {
		const raw = localStorage.getItem(SURFACE_HIDDEN_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) return [];
		return parsed.filter((id): id is string => typeof id === "string" && id !== "");
	} catch {
		return [];
	}
}

export function writeHiddenSurfaces(ids: readonly string[]): void {
	try {
		localStorage.setItem(SURFACE_HIDDEN_KEY, JSON.stringify([...ids]));
	} catch {
		/* ignore */
	}
}

/** 读取（并按注册表兜底）工具栏顺序；返回稳定顺序的字面 id 列表。 */
export function readSurfaceOrder(cwd?: string): string[] {
	const key = cwd ? `${SURFACE_CTX_PREFIX}${cwd}` : SURFACE_ORDER_KEY;
	let order: string[] = [];
	try {
		const raw = localStorage.getItem(key);
		if (raw) order = JSON.parse(raw);
	} catch {
		/* ignore */
	}
	// 兜底 = 注册表顺序，并落掉已不存在的 id
	const fallback = SURFACES.map(s => s.id);
	const validNew = order.filter(id => byId.has(id));
	const missing = fallback.filter(id => !(validNew as string[]).includes(id));
	return [...validNew, ...missing];
}

export function writeSurfaceOrder(ids: string[], cwd?: string): void {
	const key = cwd ? `${SURFACE_CTX_PREFIX}${cwd}` : SURFACE_ORDER_KEY;
	try {
		localStorage.setItem(key, JSON.stringify(ids));
	} catch {
		/* ignore */
	}
}
