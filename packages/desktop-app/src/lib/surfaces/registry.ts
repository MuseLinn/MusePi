/*
 * Surface registry for the right toolbar/panel: each surface declares
 * id/label/icon/availability/defaultWidthFraction; the RightRail orders,
 * hides, and sizes the panel accordingly. Pure module data + persistence,
 * no React.
 */
import type { AgentSnapshot } from "@musepi/pi-wire";
import type { PanelTabDescriptor } from "../panel-tabs";
import type { RpcClient } from "../rpc";

export type SurfaceAvailability = "always" | "has-content";
export type SurfaceId =
	| "context"
	| "files"
	| "artifacts"
	| "trajectory"
	| "jobs"
	| "git"
	| "pr"
	| "diff"
	| "notes"
	| "browser"
	| "agent"
	| "session"
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
	/** 依赖会话：无 sessionId 时不可开启。rail 隐藏它；面板空态页把它渲染成
	 *  禁用项（保留“这里有什么”的信息，而不是假装不存在）。 */
	requiresSession?: boolean;
	/** 面板默认宽度占比（0..1），起步宽由它决定 */
	defaultWidthFraction: number;
	/** 可选：是否有一个对应“是否有内容”的判定 */
	hasContent?(ctx: SurfaceProps): boolean;
	render?(rpc: RpcClient | null, props: SurfaceProps): unknown;
}

export const COMPACTION_PANEL_SURFACE = "ext:panel.tab.compaction";

/** Address-only descriptor: summary content is re-read from the daemon. */
export function compactionTabDescriptor(entryId: string, label: string): PanelTabDescriptor {
	return {
		surface: COMPACTION_PANEL_SURFACE,
		target: entryId,
		dedupeKey: entryId,
		label,
		readOnly: true,
	};
}

/**
 * One subagent session tab. Identity is the AGENT id, not the address: a
 * live-progress row and a disk-roster row for the same agent must land on one
 * tab, even though only the roster knows the child session id.
 */
export function agentTabDescriptor(
	agent: Pick<AgentSnapshot, "id" | "displayName">,
	childSessionId?: string | null,
): PanelTabDescriptor {
	return {
		surface: "agent",
		target: childSessionId ?? agent.id,
		dedupeKey: agent.id,
		label: agent.displayName,
		readOnly: false,
	};
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
		requiresSession: true,
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
	// Background async jobs (Kimi parity): the composer chip opens this tab;
	// secondary so the rail keeps its primary icons while the surface stays
	// discoverable in the overflow menu.
	{
		id: "jobs",
		label: "general.backgroundJobs",
		description: "surface description jobs",
		icon: "task",
		group: "secondary",
		availability: "always",
		requiresSession: true,
		defaultWidthFraction: 0.5,
	},
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
		requiresSession: true,
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
	 * the tail. */
	{
		id: "agents",
		label: "agents",
		description: "surface description agents",
		icon: "ai-agent",
		group: "primary",
		availability: "always",
		requiresSession: true,
		defaultWidthFraction: 0.5,
	},
	// Subagent session detail (agents-hub drill-down): one tab per agent, so
	// its live transcript + chat sit beside the roster instead of only in the
	// in-pane drawer. Tertiary: it never occupies the rail.
	{
		id: "agent",
		label: "agents.subagentTab",
		icon: "ai-agent",
		group: "tertiary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
	// A normal session shown beside the active chat. Unlike `agent`, the
	// target is an ordinary session id and the body is the full steerable
	// session view (transcript + composer + approval/ask dock). Tertiary:
	// opened from the session list, never from the rail.
	{
		id: "session",
		label: "general.sideSession",
		icon: "layout-right",
		group: "tertiary",
		availability: "always",
		defaultWidthFraction: 0.5,
	},
];

const byId = new Map<string, SurfaceDescriptor>(SURFACES.map(s => [s.id, s]));
export function surfaceById(id: string | null): SurfaceDescriptor | undefined {
	return id ? byId.get(id) : undefined;
}

/** 会话级表面（context / trajectory / agents）在没有 sessionId 时不能开启：
 *  它们读的都是会话状态，打开只会得到一屏占位。 */
export function surfaceRequiresSession(s: SurfaceDescriptor): boolean {
	return s.requiresSession === true;
}

/** 对于 has-content surface：有判定函数用它；否则退到"有打开的 tab 即可见"
 * —— 用户正在用的面板不因状态变化消失。会话级表面还要求当前有会话。 */
export function surfaceVisible(s: SurfaceDescriptor, ctx: SurfaceProps): boolean {
	if (surfaceRequiresSession(s) && !ctx.sessionId) return false;
	if (s.availability === "always") return true;
	if (s.hasContent) return s.hasContent(ctx);
	return ctx.openSurfaces?.has(s.id) ?? false;
}

/* ── 持久化 ───────────────────────────────────────────────────── */
export const SURFACE_ORDER_KEY = "musepi-gui-right-order";
export const SURFACE_CTX_PREFIX = "musepi-gui-right-ctx-";
export const SURFACE_WIDTHS_KEY = "musepi-gui-right-widths";
export const SURFACE_HIDDEN_KEY = "musepi-gui-right-hidden";
/** One width for the whole right panel — switching tabs must not resize it. */
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

function clampWidth(px: number): number {
	return Math.min(1200, Math.max(200, Math.round(px)));
}

function readStoredPanelWidth(): number | null {
	try {
		const raw = localStorage.getItem(SURFACE_WIDTH_KEY);
		if (raw === null || raw.trim() === "") return null;
		const n = Number(raw);
		return Number.isFinite(n) ? clampWidth(n) : null;
	} catch {
		return null;
	}
}

/** One remembered width for the whole panel: shared key → first valid legacy
 *  per-surface value → default fraction. */
export function panelWidth(defaultWidthFraction: number): number {
	const shared = readStoredPanelWidth();
	if (shared !== null) return shared;
	const legacy = Object.values(readSurfaceWidths())[0];
	if (legacy !== undefined) return legacy;
	return clampWidth(defaultWidthFraction * 900);
}

export function writePanelWidth(px: number): void {
	try {
		localStorage.setItem(SURFACE_WIDTH_KEY, String(clampWidth(px)));
	} catch {
		/* ignore */
	}
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
	// 兜底 = 注册表顺序，并落掉已不存在的 id。Tertiary surfaces are tab hosts
	// opened by their owner (an agent's session), never rail entries — so they
	// are neither restored into the rail nor addressed by ⌘-digit shortcuts.
	const fallback = SURFACES.filter(s => s.group !== "tertiary").map(s => s.id);
	const validNew = order.filter(id => {
		const surface = byId.get(id);
		return surface !== undefined && surface.group !== "tertiary";
	});
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
