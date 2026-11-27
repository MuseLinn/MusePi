import type { ComposerEditorHandle } from "@musepi/client-core/src/components/composer/composer-editor-types";
import { type Dispatch, type SetStateAction, useEffect, useRef, useState } from "react";
import { t } from "../../i18n/index.js";
import {
	type AtCandidate,
	type AtCompletionEntry,
	loadAtCompletionEntries,
	rankAtCandidates,
} from "../../lib/at-completion";
import { currentLine, tokenQuery } from "../../lib/completion-trigger";
import type { RpcClient } from "../../lib/rpc";
import { rankSlashEntries } from "../../lib/slash-rank";
import { autosize } from "../composer-autosize";
import type { SessionListNode } from "../SessionList";
import type { SlashEntry } from "../SlashRow";
import type { SessionCompletionEntry } from "./completion-menus";

/** Composer-intercepted slash commands (open GUI panels or fire GUI-owned
 *  RPCs instead of hitting the agent) — they win ties in the / completion
 *  ranking. */
const SLASH_GUI_NATIVE: ReadonlySet<string> = new Set(["usage", "context", "guided-goal"]);

/** How many sessions the "@" menu offers before the query narrows them. */
const AT_SESSION_LIMIT = 50;

/** Display title for a session row: the session tree's label, else the cwd
 *  basename, else a short id slice. The inserted token always keeps the full
 *  id, so a short label can never change what gets referenced. */
function sessionRowLabel(entry: { id: string; cwd?: string }, labels: ReadonlyMap<string, string>): string {
	const tree = labels.get(entry.id);
	if (tree) return tree;
	const base = entry.cwd?.split("/").filter(Boolean).at(-1);
	if (base) return base;
	return entry.id.slice(0, 8);
}

/**
 * "@"/"/" completion machinery (TUI parity): both state machines share the
 * textarea anchor and the draft setter. "/" lists the daemon's builtin
 * registry (commands.list); "@" owns every reference — the workspace tree
 * scan (workspace.tree) plus the session list (session.list with
 * session.tree titles), so a conversation is pulled in the same way a file
 * is. Enter/click inserts the token via the shared textarea ref. Pure state + handlers (no effects); the menus
 * themselves render through CompletionMenus, which owns the portaled anchor
 * and the scroll-into-view effect.
 */
export function useCompletion({
	rpc,
	cwd,
	sessionId,
	extraRoots,
	setText,
	atMaxDepth,
	editorRef,
}: {
	rpc: RpcClient | null;
	cwd?: string;
	/** Live session id — "@" spans every working directory of the session. */
	sessionId?: string | null;
	/** Remembered roots for hosts without a live session (welcome composer). */
	extraRoots?: readonly string[];
	setText(value: string): void;
	/** Depth cap for "@" rows; omitted = every scanned depth (session parity). */
	atMaxDepth?: number;
	/** A ref owned by the host, so another controller (dictation) can drive the
	 *  same editor. Omitted = this hook owns one. */
	editorRef?: { current: ComposerEditorHandle | null };
}): {
	taRef: { current: ComposerEditorHandle | null };
	// Slash-command completion (TUI parity): typing "/" lists the daemon's
	// builtin registry; Enter/click inserts the command token.
	slashOpen: boolean;
	setSlashOpen(open: boolean): void;
	slashIdx: number;
	setSlashIdx: Dispatch<SetStateAction<number>>;
	slashFilter: SlashEntry[];
	/** Full command registry (commands.list) once fetched — the slash
	 *  badge tip keys off it. */
	slashCmds: SlashEntry[] | null;
	onSlashInput(value: string): void;
	insertSlash(name: string): void;
	// "@" completion (TUI/ZCode parity): @ = files & folders from the
	// workspace tree scan (workspace.tree) plus the session list
	// (session.list) — one menu, two kinds of reference.
	atOpen: boolean;
	setAtOpen(open: boolean): void;
	atIdx: number;
	setAtIdx: Dispatch<SetStateAction<number>>;
	atFilter: AtCandidate[];
	/** Current "@" query, for marking the matched substring in each row. */
	atQuery: string;
	onAtInput(value: string): void;
	insertAt(candidate: AtCandidate | string): void;
} {
	const ownedRef = useRef<ComposerEditorHandle | null>(null);
	const taRef = editorRef ?? ownedRef;
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
	// A session switch invalidates the merged root scan; the generation guard
	// drops a scan that resolves after the switch.
	const atRequestRef = useRef(0);
	useEffect(() => {
		atRequestRef.current += 1;
		setAtEntries(null);
	}, [sessionId, cwd, extraRoots]);
	/** Session candidates for the "@" menu — loaded on first open, so a
	 *  session is referenced the same way a file is. */
	const [atSessions, setAtSessions] = useState<SessionCompletionEntry[] | null>(null);
	/** Session titles from session.tree (renames / first-message labels). */
	const [sessionLabels, setSessionLabels] = useState<Map<string, string>>(new Map());

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
			description: t("general.showSubscriptionUsage"),
			kind: "command",
			category: "GUI",
		};
		const guiContextCmd: SlashEntry = {
			name: "context",
			description: t("general.showContextUsage"),
			kind: "command",
			category: "GUI",
		};
		const list = [
			// The daemon filters `commands.list` by surface: everything it returns
			// is offered on GUI. TUI dashboards and GUI-panel commands are declared
			// on the command itself, so no client-side whitelist decides visibility.
			...(slashCmds ?? []).filter(c => c.name !== "usage" && c.name !== "context"),
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
					.request<SlashEntry[]>("commands.list", { surface: "gui" })
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
				const request = ++atRequestRef.current;
				void loadAtCompletionEntries({ rpc, cwd, sessionId, extraRoots })
					.then(entries => {
						if (atRequestRef.current !== request) return;
						setAtEntries(atMaxDepth === undefined ? entries : entries.filter(e => e.depth <= atMaxDepth));
					})
					.catch(() => {
						if (atRequestRef.current === request) setAtEntries([]);
					});
			}
			// Sessions join the same menu: "@" is one gesture ("pull that thing
			// in"), and two sigils for files and conversations would make the
			// reader remember which reaches which. Loaded alongside the tree so
			// the list never shows one kind and then the other.
			if (!atSessions && rpc) {
				const request = ++atRequestRef.current;
				void rpc
					.request<SessionCompletionEntry[]>("session.list", {})
					.then(list => {
						if (atRequestRef.current !== request) return;
						setAtSessions(list ?? []);
					})
					.catch(() => {
						if (atRequestRef.current === request) setAtSessions([]);
					});
				// Titles live in the session tree rather than the list, and a
				// row that only says an id slice is not something a reader can
				// choose between.
				void rpc
					.request<SessionListNode[]>("session.tree", {})
					.then(nodes => {
						if (atRequestRef.current !== request) return;
						const labels = new Map<string, string>();
						const walk = (ns: SessionListNode[]): void => {
							for (const n of ns) {
								const label = n.entry.label ?? n.label;
								if (label) labels.set(n.entry.id, label);
								walk(n.children);
							}
						};
						walk(nodes ?? []);
						setSessionLabels(labels);
					})
					.catch(() => {});
			}
		} else {
			setAtOpen(false);
		}
	};

	// Rank first, then cap: taking the first 50 rows of an unsorted list would
	// hide the session that actually matches the query behind the newest ones.
	const atRanked = rankAtCandidates(
		[
			...(atSessions ?? [])
				.filter(s => s.id !== sessionId && s.subagent !== true && s.advisor !== true)
				.map(
					(s): AtCandidate => ({
						kind: "session",
						id: s.id,
						name: sessionRowLabel(s, sessionLabels),
						cwd: s.cwd,
						updatedAt: s.updatedAt,
					}),
				),
			...(atEntries ?? []).map((e): AtCandidate => ({ kind: "file", ...e })),
		],
		atQuery,
	);
	// A picker is not a directory listing: cap the session half so a long
	// history cannot push the file half out of the menu.
	let sessionSlots = AT_SESSION_LIMIT;
	const atFilter = atRanked.filter(candidate => {
		if (candidate.kind !== "session") return true;
		if (sessionSlots <= 0) return false;
		sessionSlots -= 1;
		return true;
	});

	const insertAt = (candidate: AtCandidate | string): void => {
		const ta = taRef.current;
		if (!ta) return;
		// A session inserts a read-tool-resolvable URL; a file inserts its path
		// (absolute for additional roots, whose relative path would resolve
		// against the wrong directory).
		const inserted =
			typeof candidate === "string"
				? candidate
				: candidate.kind === "session"
					? `history://${candidate.id}`
					: (candidate.insertPath ?? candidate.path);
		// Replace the "@query" token in place: the @ may sit mid-line after
		// Chinese text or punctuation, so the split runs through its anchor.
		const anchor = atAnchor ?? ta.value.lastIndexOf("\n");
		const prefix = ta.value.slice(0, anchor + 1); // up to and including "@"
		const rest = ta.value.slice(anchor + 1 + atQuery.length);
		setText(`${prefix}${inserted} ${rest}`);
		setAtOpen(false);
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
		atQuery,
		onAtInput,
		insertAt,
	};
}
