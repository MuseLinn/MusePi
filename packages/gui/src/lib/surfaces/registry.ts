/*
 * Surface registry for the right toolbar/panel: each surface declares
 * id/label/icon/availability/defaultWidthFraction; the RightRail orders,
 * hides, and sizes the panel accordingly. Pure module data + persistence,
 * no React.
 */
import type { RpcClient } from "../rpc";

export type SurfaceAvailability = "always" | "has-content";
export type SurfaceId =
	| "context" | "files" | "widget" | "trajectory" | "jobs"
	| "git" | "pr" | "diff" | "notes" | "browser"
	| (string & {}); // 扩展槽注入（panel.tab.* / rail.*）

export interface SurfaceProps {
	rpc: RpcClient | null;
	sessionId?: string | null;
	cwd?: string;
}

export type SurfaceGroup = "primary" | "secondary" | "tertiary";

export interface SurfaceDescriptor {
	id: SurfaceId;
	/** i18n key（用 t() 取 display） */
	label: string;
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
	{ id: "context", label: "chat.context", icon: "pie-chart", group: "primary", availability: "always", defaultWidthFraction: 0.5 },
	{ id: "files", label: "chat.files", icon: "folder", group: "primary", availability: "always", defaultWidthFraction: 0.5 },
	{ id: "git", label: "chat.git", icon: "git-branch", group: "primary", availability: "always", defaultWidthFraction: 0.55 },
	{ id: "diff", label: "chat.diff", icon: "file", group: "secondary", availability: "always", defaultWidthFraction: 0.55 },
	{ id: "pr", label: "chat.pr", icon: "git-pull-request", group: "secondary", availability: "always", defaultWidthFraction: 0.5 },
	{ id: "notes", label: "chat.notes", icon: "book-open", group: "primary", availability: "always", defaultWidthFraction: 0.5 },
	{ id: "browser", label: "chat.browser", icon: "global", group: "primary", availability: "always", defaultWidthFraction: 0.6 },
];

const byId = new Map<string, SurfaceDescriptor>(SURFACES.map(s => [s.id, s]));
export function surfaceById(id: string | null): SurfaceDescriptor | undefined {
	return id ? byId.get(id) : undefined;
}

/** 对于 has-content surface，仅当 ctx 判定成功才显示。 */
export function surfaceVisible(s: SurfaceDescriptor, ctx: SurfaceProps): boolean {
	if (s.availability === "always") return true;
	return s.hasContent ? s.hasContent(ctx) : false;
}

/* ── 持久化 ───────────────────────────────────────────────────── */
export const SURFACE_ORDER_KEY = "musepi-gui-right-order";
export const SURFACE_CTX_PREFIX = "musepi-gui-right-ctx-";
export const SURFACE_WIDTH_KEY = "musepi-gui-right-width";

/** 读取（并按注册表兜底）工具栏顺序；返回稳定顺序的字面 id 列表。 */
export function readSurfaceOrder(cwd?: string): string[] {
	const key = cwd ? `${SURFACE_CTX_PREFIX}${cwd}` : SURFACE_ORDER_KEY;
	let order: string[] = [];
	try {
		const raw = localStorage.getItem(key);
		if (raw) order = JSON.parse(raw);
	} catch { /* ignore */ }
	// 兜底 = 注册表顺序，并落掉已不存在的 id
	const fallback = SURFACES.map(s => s.id);
	const validNew = order.filter(id => byId.has(id));
	const missing = fallback.filter(id => !(validNew as string[]).includes(id));
	return [...validNew, ...missing];
}

export function writeSurfaceOrder(ids: string[], cwd?: string): void {
	const key = cwd ? `${SURFACE_CTX_PREFIX}${cwd}` : SURFACE_ORDER_KEY;
	try { localStorage.setItem(key, JSON.stringify(ids)); } catch { /* ignore */ }
}

export function readSurfaceWidth(cwd?: string): number {
	const key = cwd ? `${SURFACE_CTX_PREFIX}${cwd}:w` : SURFACE_WIDTH_KEY;
	try { const n = Number(localStorage.getItem(key)); if (Number.isFinite(n)) return Math.min(900, Math.max(200, n)); } catch {}
	return 300;
}
export function writeSurfaceWidth(w: number, cwd?: string): void {
	const key = cwd ? `${SURFACE_CTX_PREFIX}${cwd}:w` : SURFACE_WIDTH_KEY;
	try { localStorage.setItem(key, String(Math.round(w))); } catch {}
}
