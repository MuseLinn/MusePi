import { useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import { currentLine, tokenQuery } from "../../lib/completion-trigger";
import type { RpcClient } from "../../lib/rpc";
import { rankSlashEntries } from "../../lib/slash-rank";
import { autosize } from "../composer-autosize";
import type { SessionListNode } from "../SessionList";
import type { SlashEntry } from "../SlashRow";
import type { AtCompletionEntry, HashCompletionEntry } from "./completion-menus";

/** Composer-intercepted slash commands (open GUI panels or fire GUI-owned
 *  RPCs instead of hitting the agent) — they win ties in the / completion
 *  ranking. */
const SLASH_GUI_NATIVE: ReadonlySet<string> = new Set(["usage", "context", "guided-goal"]);

/** TUI-only daemon commands the GUI intercepts with its own handling — own
 *  panels (usage/context/debug/btw/autoresearch) or the guided-goal RPC
 *  (startGuidedGoal, TUI /guided-goal parity with inline args). These are
 *  the only tuiOnly entries allowed to stay in the / menu (everything else
 *  tuiOnly can only answer "该命令仅在终端中可用", so it is hidden). */
const GUI_PANEL_INTERCEPTS: ReadonlySet<string> = new Set([
	"usage",
	"context",
	"debug",
	"btw",
	"autoresearch",
	"guided-goal",
]);

/**
 * "@"/"#"/"//" completion machinery (TUI parity): the three completion
 * state machines share the textarea anchor and the draft setter. "/"
 * lists the daemon's builtin registry (commands.list), "@" the workspace
 * tree scan (workspace.tree), "#" the session list (session.list with
 * session.tree labels) — Enter/click inserts the token via the shared
 * textarea ref. Pure state + handlers (no effects); the menus themselves
 * render through CompletionMenus, which owns the portaled anchor and the
 * scroll-into-view effect.
 */
export function useCompletion({
	rpc,
	cwd,
	setText,
}: {
	rpc: RpcClient | null;
	cwd?: string;
	setText(value: string): void;
}): {
	taRef: { current: HTMLTextAreaElement | null };
	// Slash-command completion (TUI parity): typing "/" lists the daemon's
	// builtin registry; Enter/click inserts the command token.
	slashOpen: boolean;
	setSlashOpen(open: boolean): void;
	slashIdx: number;
	setSlashIdx(v: (prev: number) => number): void;
	slashFilter: SlashEntry[];
	/** Full command registry (commands.list) once fetched — the slash
	 *  badge tip keys off it. */
	slashCmds: SlashEntry[] | null;
	onSlashInput(value: string): void;
	insertSlash(name: string): void;
	// "@" completion (TUI/ZCode parity): @ = files & folders from the
	// workspace tree scan (workspace.tree), NOT agents.
	atOpen: boolean;
	setAtOpen(open: boolean): void;
	atIdx: number;
	setAtIdx(v: (prev: number) => number): void;
	atFilter: AtCompletionEntry[];
	onAtInput(value: string): void;
	insertAt(path: string): void;
	// "#" completion (insert a session reference): lists session.list, with
	// titles resolved from session.tree labels (fallback: cwd basename).
	hashOpen: boolean;
	setHashOpen(open: boolean): void;
	hashIdx: number;
	setHashIdx(v: (prev: number) => number): void;
	hashFilter: HashCompletionEntry[];
	hashLabel(e: { id: string; cwd?: string }): string;
	onHashInput(value: string): void;
	insertHash(id: string): void;
} {
	const taRef = useRef<HTMLTextAreaElement | null>(null);
	// Slash-command completion (TUI parity): typing "/" lists the daemon's
	// builtin registry; Enter/click inserts the command token.
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashQuery, setSlashQuery] = useState("");
	/** Index (in the full textarea value) of the "/" that opened the command
	 *  token — with a mid-line trigger the completion must replace from HERE,
	 *  not from line start (mirrors atAnchor). */
	const [slashAnchor, setSlashAnchor] = useState<number | null>(null);
	const [slashCmds, setSlashCmds] = useState<SlashEntry[] | null>(null);
	// Selection index must be STATE: arrow keys set it inside onKeyDown and
	// the active-row highlight depends on it — a ref never re-renders, so
	// the highlight only moved on unrelated renders (typing/streaming).
	const [slashIdx, setSlashIdx] = useState(0);
	// "@" completion (TUI/ZCode parity): @ = files & folders from the
	// workspace tree scan (workspace.tree), NOT agents.
	const [atOpen, setAtOpen] = useState(false);
	const [atQuery, setAtQuery] = useState("");
	/** Index (in the full textarea value) of the "@" that opened the mention
	 *  token — the completion must replace from HERE, not from line start. */
	const [atAnchor, setAtAnchor] = useState<number | null>(null);
	const [atEntries, setAtEntries] = useState<AtCompletionEntry[] | null>(null);
	const [atIdx, setAtIdx] = useState(0);
	// "#" completion (insert a session reference): lists session.list, with
	// titles resolved from session.tree labels (fallback: cwd basename).
	const [hashOpen, setHashOpen] = useState(false);
	const [hashQuery, setHashQuery] = useState("");
	/** Index (in the full textarea value) of the "#" that opened the session
	 *  token — mirrors slashAnchor/atAnchor so a mid-line "#" splices in place. */
	const [hashAnchor, setHashAnchor] = useState<number | null>(null);
	const [hashSessions, setHashSessions] = useState<HashCompletionEntry[] | null>(null);
	const [hashLabels, setHashLabels] = useState<Map<string, string>>(new Map());
	const [hashIdx, setHashIdx] = useState(0);

	const slashFilter = (() => {
		const q = slashQuery.toLowerCase();
		// /skill, /skills, /skill: — the user's intent is the skill list:
		// surface every skill command (kind: skill) instead of matching
		// against literal "skills" text (skill:foo doesn't contain it).
		const isSkillQuery = q === "skill" || q === "skills" || q.startsWith("skill:");
		// GUI-native /usage + /context: the daemon's catalog already carries
		// the TUI's commands (with show/reset subcommands) — sending either
		// to the agent returns ANSI panel text, and the composer intercepts
		// the bare commands anyway, so keep ONE GUI entry per command (with
		// the friendly description + GUI category) and drop the daemon's.
		const guiUsageCmd: SlashEntry = {
			name: "usage",
			description: t("show subscription usage"),
			kind: "command",
			category: "GUI",
		};
		const guiContextCmd: SlashEntry = {
			name: "context",
			description: t("show context usage"),
			kind: "command",
			category: "GUI",
		};
		const list = [
			// Hide TUI-only daemon commands the GUI has no handling for — they
			// can only answer "该命令仅在终端中可用" when sent. GUI-intercepted
			// names (panel or guided-RPC parity) and skill commands stay visible.
			...(slashCmds ?? []).filter(
				c =>
					c.name !== "usage" && c.name !== "context" && !(c.tuiOnly === true && !GUI_PANEL_INTERCEPTS.has(c.name)),
			),
			guiUsageCmd,
			guiContextCmd,
		];
		// Ranked (slash-rank.ts): exact/prefix matches first, GUI-native
		// commands win ties — /usage and /context open panels instead of
		// hitting the agent, so they belong above look-alike daemon entries.
		return rankSlashEntries(
			list.filter(c =>
				isSkillQuery && c.kind === "skill"
					? true
					: c.name.includes(q) || (c.description ?? "").toLowerCase().includes(q),
			),
			q,
			SLASH_GUI_NATIVE,
		);
	})();

	/**
	 * A "/" opens command completion when it is not glued to ASCII word
	 * characters — the same rule "@" already follows (see lib/completion-trigger).
	 * The old check demanded a line-leading "/", so a "/" typed after body text
	 * ("请继续/" or even "/请继续", where the query then became the whole sentence
	 * and ranked to zero entries) never opened the menu.
	 */
	const onSlashInput = (value: string): void => {
		const { line, lineStart } = currentLine(value);
		const hit = tokenQuery(line, "/");
		if (hit) {
			setSlashQuery(hit.query);
			setSlashAnchor(lineStart + hit.anchor);
			setSlashOpen(true);
			setSlashIdx(0);
			if (!slashCmds && rpc) {
				void rpc
					.request<SlashEntry[]>("commands.list", {})
					.then(list => setSlashCmds(list ?? []))
					.catch(() => {});
			}
		} else {
			setSlashOpen(false);
		}
	};

	const insertSlash = (name: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		// Replace the anchored "/query" token with "/name " — the anchor is
		// recorded when the menu opens, so a "/" typed mid-line splices there
		// instead of clobbering the start of the line.
		const anchor = slashAnchor ?? ta.value.lastIndexOf("\n") + 1;
		const prefix = ta.value.slice(0, anchor);
		const rest = ta.value.slice(anchor + slashQuery.length + 1);
		const next = `${prefix}/${name} ${rest}`;
		setText(next);
		setSlashOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	const onAtInput = (value: string): void => {
		// Trigger on the LAST triggering "@" of the current line — the mention
		// token is the text after it. The old rule required a line-leading "@", so
		// typing "请看@文件" (Chinese body text before the @) never opened the
		// panel; the shared rule (lib/completion-trigger) also makes that
		// consistent with the welcome composer and with "/".
		const { line, lineStart } = currentLine(value);
		const hit = tokenQuery(line, "@");
		if (hit) {
			const query = hit.query;
			setAtQuery(query);
			setAtAnchor(lineStart + hit.anchor);
			setAtOpen(true);
			setAtIdx(0);
			if (!atEntries && rpc) {
				void rpc
					.request<{
						entries: { name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }[];
					}>("workspace.tree", { cwd: cwd ?? "", maxDepth: 3, perDirLimit: 100 })
					.then(res =>
						setAtEntries(
							(res.entries ?? []).map(e => ({
								name: e.name,
								path: e.path,
								isDir: e.isDir,
								depth: e.depth,
							})),
						),
					)
					.catch(() => setAtEntries([]));
			}
		} else {
			setAtOpen(false);
		}
	};

	const atFilter =
		atEntries?.filter(
			e =>
				e.name.toLowerCase().includes(atQuery.toLowerCase()) ||
				e.path.toLowerCase().includes(atQuery.toLowerCase()),
		) ?? [];

	const insertAt = (path: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		// Replace the "@query" token in place: the @ may sit mid-line after
		// Chinese text or punctuation, so the split runs through its anchor.
		const anchor = atAnchor ?? ta.value.lastIndexOf("\n");
		const prefix = ta.value.slice(0, anchor + 1); // up to and including "@"
		const rest = ta.value.slice(anchor + 1 + atQuery.length);
		setText(`${prefix}${path} ${rest}`);
		setAtOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	const onHashInput = (value: string): void => {
		// Same shared trigger rule as "/" and "@" (lib/completion-trigger).
		const { line, lineStart } = currentLine(value);
		const hit = tokenQuery(line, "#");
		if (hit) {
			setHashQuery(hit.query);
			setHashAnchor(lineStart + hit.anchor);
			setHashOpen(true);
			setHashIdx(0);
			if (!hashSessions && rpc) {
				void rpc
					.request<{ id: string; timestamp?: string; messageCount?: number; cwd?: string }[]>("session.list", {})
					.then(list => setHashSessions(list ?? []))
					.catch(() => setHashSessions([]));
				// Titles come from the session tree (renames/首条消息 labels);
				// fetch alongside the list so rows show names, not raw ids.
				void rpc
					.request<SessionListNode[]>("session.tree", {})
					.then(nodes => {
						const labels = new Map<string, string>();
						const walk = (ns: SessionListNode[]): void => {
							for (const n of ns) {
								const label = n.entry.label ?? n.label;
								if (label) labels.set(n.entry.id, label);
								walk(n.children);
							}
						};
						walk(nodes ?? []);
						setHashLabels(labels);
					})
					.catch(() => {});
			}
		} else {
			setHashOpen(false);
		}
	};

	const hashFilter =
		hashSessions?.filter(
			e =>
				(e.id ?? "").toLowerCase().includes(hashQuery.toLowerCase()) ||
				(e.cwd ?? "").toLowerCase().includes(hashQuery.toLowerCase()),
		) ?? [];

	// Display title for a # row: session.tree label, else cwd basename,
	// else a short id slice (the inserted token always keeps the full id).
	const hashLabel = (e: { id: string; cwd?: string }): string => {
		const tree = hashLabels.get(e.id);
		if (tree) return tree;
		const base = e.cwd?.split("/").filter(Boolean).at(-1);
		if (base) return base;
		return e.id.slice(0, 8);
	};

	const insertHash = (id: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		// Splice through the recorded "#" anchor (it may sit mid-line).
		const anchor = hashAnchor ?? ta.value.lastIndexOf("\n") + 1;
		const prefix = ta.value.slice(0, anchor);
		const rest = ta.value.slice(anchor + hashQuery.length + 1);
		// Insert a read-tool-resolvable internal URL (TUI parity: the "#"
		// GitHub-ref completion rewrites to issue://pr:// URLs). The model
		// can `read history://<id>` to inspect the referenced session.
		setText(`${prefix}history://${id} ${rest}`);
		setHashOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	return {
		taRef,
		slashOpen,
		setSlashOpen,
		slashIdx,
		setSlashIdx,
		slashFilter,
		slashCmds,
		onSlashInput,
		insertSlash,
		atOpen,
		setAtOpen,
		atIdx,
		setAtIdx,
		atFilter,
		onAtInput,
		insertAt,
		hashOpen,
		setHashOpen,
		hashIdx,
		setHashIdx,
		hashFilter,
		hashLabel,
		onHashInput,
		insertHash,
	};
}
