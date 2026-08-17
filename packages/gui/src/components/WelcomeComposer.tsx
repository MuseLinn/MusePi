import { type TranslationKey, t } from "@musepi/collab-web";
import type { FormEvent, ReactNode } from "react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ComposerFrame } from "../lib/composer-frame";
import { X } from "lucide-react";
import { projectName } from "../lib/electron";
import { readAutoResizeImages, readFileAsDataURL, resizeImageDataUrl } from "../lib/image-resize";
import type { RpcClient } from "../lib/rpc";
import { sfxFor } from "../lib/sfx";
import { useFloatingMenu } from "../lib/use-floating-menu";
import { Icon } from "../vendor/oc-icons";
import { AttachMenu } from "./AttachMenu";
import { BlurText } from "./BlurText";
import { autosize } from "./composer-autosize";
import { DotMatrixMark } from "./DotMatrixMark";
import { ModelSelector } from "./ModelSelector";
import { PetSprite, usePet } from "./PetSprite";
import { type ReminderRow, RemindersPanel } from "./RemindersPanel";
import { ShinyText } from "./ShinyText";
import { type SlashEntry, SlashRow } from "./SlashRow";
import { type ThinkingLevel, ThinkingSelector } from "./ThinkingSelector";

/** Time-aware greeting (ZCode-style): 早上好 / 下午好 / 晚上好 / 夜深了. */
function greeting(): string {
	const h = new Date().getHours();
	if (h < 5) return t("it is late, take care");
	if (h < 12) return t("good morning");
	if (h < 18) return t("good afternoon");
	return t("good evening");
}

/** Rotating tips shown under the composer (splash/shimmer refresh). Keys are
 * translated at render time (t is locale-aware), so a locale switch updates
 * the tip line without a reload. */
// English keys double as the en-US fallback (the i18n map only carries
// zh-CN); zh translations live in collab-web/src/i18n/zh-CN.ts.
const TIP_KEYS = [
	"try / for commands and @ for context",
	"press ⌘N to start a new session",
	"ask the agent to explain a file with @",
	"approval cards appear when a tool needs your ok",
	"your sessions persist across restarts",
	"switch accent colors from the top bar",
] as const;

/** Pick a random tip key, avoiding the current one. */
function nextTip(current: (typeof TIP_KEYS)[number]): (typeof TIP_KEYS)[number] {
	const pool = TIP_KEYS.filter(x => x !== current);
	return pool[Math.floor(Math.random() * pool.length)] ?? TIP_KEYS[0]!;
}

/**
 * Empty-state composer (opencode/ZCode style): large centered input with a
 * border-beam accent, a faint brand watermark, a time-aware greeting, and a
 * rotating tip line that refreshes with a shimmer.
 */
export function WelcomeComposer({
	onSubmit,
	busy,
	rpc,
	project,
	onProject,
	focused,
	onToggleFocus,
	presetModelId,
	presetThinkingLevel,
	reminders,
	onSelectReminder,
	onMarkAllRead,
}: {
	/** First prompt; the model/thinking choices made in the composer are
	 *  carried along so the new session starts with them. planMode/goalMode
	 *  ride along when the corresponding mode chip is armed — the mode is
	 *  applied to the session this first prompt creates (goal: the prompt
	 *  text becomes the objective, openchamber parity). */
	onSubmit(
		text: string,
		opts?: {
			thinkingLevel?: ThinkingLevel | null;
			modelId?: string | null;
			images?: { type: "image"; data: string; mimeType: string }[];
			planMode?: boolean;
			goalMode?: boolean;
		},
	): Promise<void> | void;
	busy?: boolean;
	/** Daemon client for the session-less model catalog (preselect). */
	rpc: RpcClient;
	/** Current project (workspace folder), if any. */
	project?: string | null;
	/** 打开文件夹 / 远程连接 / 不在项目中 project actions. */
	/** 打开文件夹 / 远程连接 / 不在项目中 project actions, or an already
	 *  saved workspace path (picked from the saved-workspaces list). */
	onProject?(action: "folder" | "remote" | "none" | string): void;
	/** Focus mode (openchamber ⌘⇧E): the composer fills the surface. */
	focused?: boolean;
	onToggleFocus?(): void;
	/** Daemon-settings default model (modelRoles.default, boot snapshot) —
	 *  preselects the model button over the localStorage fallback. */
	presetModelId?: string | null;
	/** Daemon-settings thinking default (modelRoles.default suffix, else
	 *  settings.defaultThinkingLevel incl. auto) — boot snapshot replacing
	 *  the old localStorage mirror (omp-gui-default-thinking removed). */
	presetThinkingLevel?: ThinkingLevel | null | undefined;
	/** Welcome-scene reminders (kimi 实时提醒 parity): background-working +
	 *  completed-unread sessions rendered below the composer. */
	reminders?: readonly ReminderRow[];
	onSelectReminder?(sessionId: string): void;
	onMarkAllRead?(): void;
}): ReactNode {
	const pet = usePet();
	const [text, setText] = useState("");
	// Global selection append (Cmd/Ctrl+L, openchamber parity): any
	// non-composer selection lands here through the shared window event,
	// exactly like the session Composer's handler.
	useEffect(() => {
		const onInsert = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			const insertion = detail?.text;
			if (!insertion) return;
			setText(prev => (prev.length === 0 ? insertion : `${prev}\n${insertion}`));
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener("omp-gui-insert-text", onInsert);
		return () => window.removeEventListener("omp-gui-insert-text", onInsert);
	}, []);
	// Cmd/Ctrl+L quote cards (same style as the session Composer): quoted
	// selections render as cards above the input and are sent as `> …`
	// markdown in front of the prompt.
	const [quotes, setQuotes] = useState<string[]>([]);
	useEffect(() => {
		const onQuoteAppend = (e: Event): void => {
			const detail = (e as CustomEvent<{ text?: string }>).detail;
			const text = detail?.text;
			if (!text) return;
			setQuotes(q => (q.includes(text) ? q : [...q, text]));
			requestAnimationFrame(() => taRef.current?.focus());
		};
		window.addEventListener("omp-gui-quote-append", onQuoteAppend);
		return () => window.removeEventListener("omp-gui-quote-append", onQuoteAppend);
	}, []);
	const [attachments, setAttachments] = useState<{ id: number; dataUrl: string; mimeType: string; name: string }[]>(
		[],
	);
	// Armed plan/goal (openchamber parity): one tap arms the mode chip —
	// NO popup dialog and NO session creation, so the welcome input keeps
	// its shape. The first sent message applies the mode (goal: the
	// message text becomes the objective; plan: session opens in plan
	// mode). A second tap disarms.
	const [planArmed, setPlanArmed] = useState(false);
	const [goalArmed, setGoalArmed] = useState(false);
	const attachId = useRef(0);
	// Thinking preselect: the boot snapshot (modelRoles.default suffix →
	// defaultThinkingLevel) may arrive after first paint — apply it until the
	// user touches the selector. undefined = no snapshot yet.
	const thinkingTouched = useRef(false);
	const [thinking, setThinking] = useState<ThinkingLevel | null>("medium");
	useEffect(() => {
		if (presetThinkingLevel !== undefined && !thinkingTouched.current) setThinking(presetThinkingLevel);
	}, [presetThinkingLevel]);
	// Preselect the settings-configured default model when present; the user
	// can still switch freely before the first prompt.
	const [modelId, setModelId] = useState<string | null>(() => {
		try {
			return localStorage.getItem("omp-gui-default-model");
		} catch {
			return null;
		}
	});
	// Current model's exact thinking ladder (models.detail → getSupported
	// efforts): the selector shows off/auto + the model's real rungs, and
	// re-queries when the selection changes.
	const [thinkingEfforts, setThinkingEfforts] = useState<string[] | null>(null);
	const effectiveModelId = presetModelId ?? modelId;
	useEffect(() => {
		if (!rpc || !effectiveModelId) {
			setThinkingEfforts(null);
			return;
		}
		let cancelled = false;
		void rpc
			.request<{ efforts?: string[] } | null>("models.detail", { id: effectiveModelId })
			.then(detail => {
				if (!cancelled) setThinkingEfforts(detail?.efforts?.length ? detail.efforts : []);
			})
			.catch(() => {
				if (!cancelled) setThinkingEfforts(null);
			});
		return () => {
			cancelled = true;
		};
	}, [rpc, effectiveModelId]);
	const [tipKey, setTipKey] = useState<(typeof TIP_KEYS)[number]>(
		() => TIP_KEYS[Math.floor(Math.random() * TIP_KEYS.length)]!,
	);
	// Git branch selector (openchamber new-session parity): current branch +
	// local branch list for the active project; hidden outside a repo.
	const [branchInfo, setBranchInfo] = useState<{ current: string | null; branches: string[] } | null>(null);
	const [branchOpen, setBranchOpen] = useState(false);

	useEffect(() => {
		if (!rpc || !project) {
			setBranchInfo(null);
			return;
		}
		let cancelled = false;
		const load = (): void => {
			void rpc
				.request<{ current: string | null; branches: string[] } | { error: string }>("git.branches", {
					cwd: project,
				})
				.then(res => {
					if (cancelled || !res || "error" in res) {
						if (!cancelled && (!res || "error" in res)) setBranchInfo(null);
						return;
					}
					setBranchInfo(res);
				})
				.catch(() => {
					if (!cancelled) setBranchInfo(null);
				});
		};
		load();
		const onProjectChange = (): void => load();
		window.addEventListener("omp-gui-project-added", onProjectChange);
		return () => {
			cancelled = true;
			window.removeEventListener("omp-gui-project-added", onProjectChange);
		};
	}, [rpc, project]);
	const [switchingBranch, setSwitchingBranch] = useState(false);
	const switchBranch = useCallback(
		async (branch: string): Promise<void> => {
			if (!rpc || !project || switchingBranch) return;
			setSwitchingBranch(true);
			try {
				const res = (await rpc.request("git.checkout", { cwd: project, branch })) as
					| { ok: boolean; error?: string }
					| undefined;
				if (res && "error" in res && res.error) {
					window.dispatchEvent(new CustomEvent("omp-gui-toast", { detail: res.error }));
				} else if (res?.ok) {
					setBranchInfo(prev => (prev ? { ...prev, current: branch } : prev));
					setBranchOpen(false);
				}
			} catch {
				// rpc error → silent (daemon offline)
			} finally {
				setSwitchingBranch(false);
			}
		},
		[rpc, project, switchingBranch],
	);
	// Suggestion chips (openchamber new-session parity): one tap fills the
	// composer; the user hits Enter to send.
	const SUGGESTIONS = [
		{ key: "suggest explore codebase", labelKey: "chip explore codebase" },
		{ key: "suggest catch me up", labelKey: "chip catch me up" },
		{ key: "suggest weigh options", labelKey: "chip weigh options" },
		{ key: "suggest start feature planning", labelKey: "chip start feature planning" },
		{ key: "suggest create goal", labelKey: "chip create goal" },
		{ key: "suggest schedule task", labelKey: "chip schedule task" },
		{ key: "suggest debug issue", labelKey: "chip debug issue" },
		{ key: "suggest review changes", labelKey: "chip review changes" },
	] as const;
	// Empty-state placeholder carousel (new-task 空态 hints).
	const PLACEHOLDER_TIPS = [
		"ask anything, / for commands, @ for context…",
		"welcome tip search web",
		"welcome tip generate image",
		"welcome tip create board",
		"welcome tip draw diagram",
	] as const;
	const EXTRA_SUGGESTIONS = [
		{ key: "suggest write tests", labelKey: "chip write tests" },
		{ key: "suggest refactor", labelKey: "chip refactor" },
		{ key: "suggest performance", labelKey: "chip performance" },
		{ key: "suggest web search", labelKey: "chip web search" },
		{ key: "suggest generate image", labelKey: "chip generate image" },
		{ key: "suggest create board", labelKey: "chip create board" },
		{ key: "suggest draw diagram", labelKey: "chip draw diagram" },
	] as const;
	const [showMore, setShowMore] = useState(false);
	const ALL_SUGGESTIONS = [...SUGGESTIONS, ...EXTRA_SUGGESTIONS] as const;
	// Empty-state placeholder rotates through capability hints (new-task
	// 空态): keep the base shortcut hint first, then surface the newer
	// features (web search / images / boards / diagrams) so the empty
	// composer teaches what the agent can do.
	const [tipIdx, setTipIdx] = useState(0);
	useEffect(() => {
		const id = setInterval(() => setTipIdx(i => (i + 1) % PLACEHOLDER_TIPS.length), 4000);
		return () => clearInterval(id);
	}, []);
	const applySuggestion = (key: TranslationKey): void => {
		setText(t(key));
		requestAnimationFrame(() => taRef.current?.focus());
	};
	// Dot-matrix brand backdrop pref (设置 → 常规 toggle + custom text,
	// omp-gui-dotmatrix / omp-gui-dotmatrix-text).
	const [dotMatrixOn, setDotMatrixOn] = useState(() => localStorage.getItem("omp-gui-dotmatrix") !== "0");
	const [dotMatrixText, setDotMatrixText] = useState(() => localStorage.getItem("omp-gui-dotmatrix-text") ?? "MusePi");
	useEffect(() => {
		const on = (): void => {
			setDotMatrixOn(localStorage.getItem("omp-gui-dotmatrix") !== "0");
			setDotMatrixText(localStorage.getItem("omp-gui-dotmatrix-text") || "MusePi");
		};
		window.addEventListener("omp-dotmatrix-changed", on);
		window.addEventListener("storage", on);
		return () => {
			window.removeEventListener("omp-dotmatrix-changed", on);
			window.removeEventListener("storage", on);
		};
	}, []);
	// / @ # completion (composer parity): slash commands, workspace files,
	// session references — floating preview menus while typing.
	const [slashOpen, setSlashOpen] = useState(false);
	const [slashQuery, setSlashQuery] = useState("");
	const [slashCmds, setSlashCmds] = useState<SlashEntry[] | null>(null);
	// Selection indexes must be STATE: arrow keys set them inside onKeyDown
	// and the active-row highlight depends on them — refs never re-render,
	// so the highlight only moved on unrelated renders (typing/streaming).
	const [slashIdx, setSlashIdx] = useState(0);
	const [atOpen, setAtOpen] = useState(false);
	const [atQuery, setAtQuery] = useState("");
	const [atEntries, setAtEntries] = useState<{ name: string; path: string; isDir: boolean; depth: number }[] | null>(
		null,
	);
	const [atIdx, setAtIdx] = useState(0);
	const [hashOpen, setHashOpen] = useState(false);
	const [hashQuery, setHashQuery] = useState("");
	const [hashSessions, setHashSessions] = useState<{ id: string; cwd?: string }[] | null>(null);
	const [hashLabels, setHashLabels] = useState<Map<string, string>>(new Map());
	const [hashIdx, setHashIdx] = useState(0);
	const slashFilter =
		slashCmds?.filter(c => {
			const q = slashQuery.toLowerCase();
			// /skill, /skills, /skill: — surface every skill command (the
			// literal "skills" text never appears in skill:foo names).
			const isSkillQuery = q === "skill" || q === "skills" || q.startsWith("skill:");
			if (isSkillQuery && c.kind === "skill") return true;
			return c.name.includes(q) || (c.description ?? "").toLowerCase().includes(q);
		}) ?? [];
	const atFilter =
		atEntries?.filter(
			e =>
				e.name.toLowerCase().includes(atQuery.toLowerCase()) ||
				e.path.toLowerCase().includes(atQuery.toLowerCase()),
		) ?? [];
	// `#` completion filters the session list by query (id / label /
	// cwd) — same contract as the @ file completion below.
	const hashFilter = (hashSessions ?? []).filter(s => {
		const q = hashQuery.trim().toLowerCase();
		if (!q) return true;
		const label = hashLabels.get(s.id) ?? "";
		return (
			label.toLowerCase().includes(q) || s.id.toLowerCase().includes(q) || (s.cwd ?? "").toLowerCase().includes(q)
		);
	});
	const [projOpen, setProjOpen] = useState(false);
	// Saved workspaces (sidebar 项目 tab parity): every folder the app
	// knows (omp-gui-projects localStorage — seeded from session cwds and
	// grown by folder picks), so the workspace picker lists them for
	// one-tap switching instead of only offering 打开文件夹/远程连接.
	const [savedProjects, setSavedProjects] = useState<string[]>(() => {
		try {
			const raw = localStorage.getItem("omp-gui-projects");
			const parsed: unknown = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : [];
		} catch {
			return [];
		}
	});
	// Keep the picker list in sync with the sidebar: folder picks dispatch
	// omp-gui-project-added, and other windows (mini chat) write storage.
	useEffect(() => {
		const refresh = (): void => {
			try {
				const raw = localStorage.getItem("omp-gui-projects");
				const parsed: unknown = raw ? JSON.parse(raw) : [];
				setSavedProjects(Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === "string") : []);
			} catch {
				setSavedProjects([]);
			}
		};
		window.addEventListener("omp-gui-project-added", refresh);
		window.addEventListener("storage", refresh);
		return () => {
			window.removeEventListener("omp-gui-project-added", refresh);
			window.removeEventListener("storage", refresh);
		};
	}, []);
	// Focus-within state drives the hero beam (fades in while the composer
	// has focus, fades out on blur — no static border box).
	const [beamOn, setBeamOn] = useState(false);
	// Portaled workspace-picker popup (model/thinking selector parity): the
	// frosted glass samples real content behind it, and the exit animates.
	// Single-layer: className carries the visual (gui-proj-menu), the hook
	// provides portal + position + animation (Pop parity — no nested Pop).
	const { anchorRef: projAnchorRef, renderMenu: renderProjMenu } = useFloatingMenu(projOpen, setProjOpen, {
		className: "gui-proj-menu",
	});
	const { anchorRef: branchAnchorRef, renderMenu: renderBranchMenu } = useFloatingMenu(branchOpen, setBranchOpen, {
		className: "gui-proj-menu",
	});
	// / @ # completion preview (composer parity): one floating menu for all
	// three triggers, portaled so the glass samples real content behind it.
	const compOpen = slashOpen || atOpen || hashOpen;
	const { anchorRef: compAnchorRef, renderMenu: renderCompMenu } = useFloatingMenu(compOpen, open => {
		if (open) return;
		setSlashOpen(false);
		setAtOpen(false);
		setHashOpen(false);
	});
	// Only one completion menu is mounted at a time (conditional render), so
	// a single ref tracks whichever is open. The menu scrolls internally
	// (max-height 300px, overflow-y auto) — keep the active row in view
	// while arrow-navigating.
	const completionMenuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const menu = completionMenuRef.current;
		if (!menu) return;
		const active = menu.querySelector(".gui-slash-row--active, .gui-model-opt--active");
		active?.scrollIntoView({ block: "nearest" });
	}, [slashIdx, atIdx, hashIdx, slashOpen, atOpen, hashOpen]);

	const taRef = useRef<HTMLTextAreaElement | null>(null);
	const formRef = useRef<HTMLFormElement | null>(null);
	// Select-all + delete clears text AND attachments together (consumed
	// by onChange once the textarea reports the emptied value).
	const clearAllRef = useRef(false);
	const canSend = (text.trim().length > 0 || quotes.length > 0) && !busy;

	// Completion triggers (composer parity): line-leading / @ # open the
	// floating preview lists; Enter/click inserts the token.
	const onCompletionInput = (value: string): void => {
		const lineStart = value.lastIndexOf("\n") + 1;
		const line = value.slice(lineStart);
		if (line.startsWith("/") && line.length >= 1) {
			setSlashQuery(line.length > 1 ? line.slice(1) : "");
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
		if (line.startsWith("@") && line.length >= 1) {
			setAtQuery(line.length > 1 ? line.slice(1) : "");
			setAtOpen(true);
			setAtIdx(0);
			if (!atEntries && rpc) {
				void rpc
					.request<{
						entries: { name: string; path: string; isDir: boolean; size: number; mtime: number; depth: number }[];
					}>("workspace.tree", { cwd: project ?? "", maxDepth: 2, perDirLimit: 60 })
					.then(res => {
						const entries = (res?.entries ?? [])
							.filter(e => e.depth <= 2)
							.map(e => ({ name: e.name, path: e.path, isDir: e.isDir, depth: e.depth }));
						setAtEntries(entries);
					})
					.catch(() => setAtEntries([]));
			}
		} else {
			setAtOpen(false);
		}
		if (line.startsWith("#") && line.length >= 1) {
			setHashQuery(line.length > 1 ? line.slice(1) : "");
			setHashOpen(true);
			setHashIdx(0);
			if (!hashSessions && rpc) {
				void rpc
					.request<{ id: string; timestamp?: string; messageCount?: number; cwd?: string }[]>("session.list", {})
					.then(list => setHashSessions(list ?? []))
					.catch(() => setHashSessions([]));
				// Titles come from the session tree (renames/首条消息 labels).
				void rpc
					.request<{ entry: { id: string; label?: string }; children?: unknown[] }[]>("session.tree", {})
					.then(tree => {
						const labels = new Map<string, string>();
						const walk = (ns: { entry: { id: string; label?: string }; children?: unknown[] }[]): void => {
							for (const n of ns ?? []) {
								if (n.entry?.label) labels.set(n.entry.id, n.entry.label);
								walk((n.children as { entry: { id: string; label?: string }; children?: unknown[] }[]) ?? []);
							}
						};
						walk(tree ?? []);
						setHashLabels(labels);
					})
					.catch(() => {});
			}
		} else {
			setHashOpen(false);
		}
	};
	const insertCompletion = (type: "slash" | "at" | "hash", value: string): void => {
		const ta = taRef.current;
		if (!ta) return;
		const lineStart = ta.value.lastIndexOf("\n") + 1;
		const line = ta.value.slice(lineStart);
		const token = type === "slash" ? "/" : type === "at" ? "@" : "#";
		const qlen = line.startsWith(token) ? line.length - 1 : 0;
		const prefix = ta.value.slice(0, lineStart);
		const next = `${prefix}${token}${value} ${ta.value.slice(lineStart + qlen + 1)}`;
		setText(next);
		if (type === "slash") setSlashOpen(false);
		if (type === "at") setAtOpen(false);
		if (type === "hash") setHashOpen(false);
		requestAnimationFrame(() => autosize(taRef.current));
	};

	// Focus-mode size morph. CSS transitions don't play reliably here
	// (flex display change + the pin/reflow dance), so the morph runs on
	// the Web Animations API: from the current height AND width to the
	// inner column's size (open: fills the surface) or the content size
	// (closed: back to the 560px column). Inline styles are set to the
	// targets immediately; the running animation overrides them visually
	// (CSS animations beat normal declarations). Width is released on
	// finish (w-full matches both targets); height only when closing —
	// open must stay pinned to keep the fill.
	const morphed = useRef(false);
	const morphVer = useRef(0);
	// Size captured during render — the DOM still carries the PREVIOUS
	// layout at that point (React commits after the render phase), so the
	// morph can start from the pre-toggle size. Reading it in the effect
	// would already see the post-toggle layout (the inner column snaps to
	// max-width:none) and the width animation would never play.
	const prevSize = useRef<{ w: number; h: number } | null>(null);
	const formEl = formRef.current;
	if (formEl) {
		const r = formEl.getBoundingClientRect();
		prevSize.current = { w: r.width, h: r.height };
	}
	// Layout effect (not useEffect): the morph must pin the from-size and
	// start the WAAPI animation BEFORE the browser paints the commit state.
	// A passive effect runs after paint — for the expand direction the
	// commit already switched .gui-welcome-inner to max-width:none, so the
	// browser would paint one frame at full width (158×960 observed), then
	// the pin snaps back to 123×560 and the morph re-grows it — a flash →
	// snap-back → grow stutter that the collapse direction never shows
	// (there the pinned height survives the commit, so the first painted
	// frame is already the morph's from-frame).
	useLayoutEffect(() => {
		const form = formRef.current;
		if (!form) return;
		if (!morphed.current) {
			// First run: settle the textarea (still at the rows=3 markup
			// default — the autosize effect runs after this one) and release
			// any pinned sizes. No morph: the initial size IS the autosized
			// content size, and morphing from the rows=3 height would play a
			// shrink animation on mount.
			morphed.current = true;
			autosize(taRef.current);
			form.style.width = "";
			form.style.height = "";
			return;
		}
		const prev = prevSize.current;
		const fromW = prev ? prev.w : form.getBoundingClientRect().width;
		const fromH = prev ? prev.h : form.getBoundingClientRect().height;
		let targetW: number;
		let targetH: number;
		if (focused) {
			const inner = form.parentElement;
			targetW = inner?.getBoundingClientRect().width ?? fromW;
			targetH = inner?.getBoundingClientRect().height ?? fromH;
		} else {
			// Settle the textarea to its content height FIRST — the autosize
			// effect runs after this one (declaration order), and measuring
			// with the stale focused height (100% of a content-sized wrap
			// resolves back to rows=3) would mis-target the collapse.
			autosize(taRef.current);
			// Measure the unpinned content size (scrollHeight returns the
			// element's own size while the pinned inline styles are set;
			// same-frame restore, no visual flash).
			const prevH = form.style.height;
			const prevW = form.style.width;
			form.style.height = "";
			form.style.width = "";
			void form.offsetHeight;
			const c = form.getBoundingClientRect();
			targetH = c.height;
			targetW = c.width;
			form.style.height = prevH;
			form.style.width = prevW;
		}
		if (Math.abs(fromW - targetW) < 1 && Math.abs(fromH - targetH) < 1) {
			// No size change (e.g. the initial mount) — nothing to morph.
			form.style.width = "";
			form.style.height = "";
			return;
		}
		form.style.height = `${fromH}px`;
		form.style.width = `${fromW}px`;
		void form.offsetHeight;
		form.classList.add("gui-morphing");
		const anim = form.animate(
			[
				{ height: `${fromH}px`, width: `${fromW}px` },
				{ height: `${targetH}px`, width: `${targetW}px` },
			],
			{ duration: 280, easing: "cubic-bezier(0.22, 1, 0.36, 1)" },
		);
		form.style.height = `${targetH}px`;
		form.style.width = `${targetW}px`;
		// Release the pinned sizes once the morph settles. The finish event
		// is unreliable (headless Chromium never dispatches it, and a
		// cancelled animation won't fire it), so a versioned timer backs it
		// up — a newer morph bumps the version and supersedes the cleanup.
		// Width is always safe to release (w-full matches both targets);
		// height only when closed (open must stay pinned to keep the fill).
		const ver = ++morphVer.current;
		const release = (): void => {
			if (morphVer.current !== ver) return;
			form.classList.remove("gui-morphing");
			form.style.width = "";
			if (!focused) form.style.height = "";
		};
		anim.addEventListener("finish", release);
		setTimeout(release, 320);
	}, [focused]);

	// Autosize the textarea on mount (same behavior as the session
	// composer): the initial height IS the autosized content height, so
	// typing the first lines never resizes the card — only exceeding the
	// row cap grows it. Every keystroke autosizes synchronously in
	// onChange (mirroring Composer), and the focus morph settles it
	// explicitly when leaving focus mode.
	useEffect(() => {
		autosize(taRef.current);
	}, []);

	// Rotate the tip every ~6s with a shimmer refresh (key change re-triggers).
	useEffect(() => {
		let id = setInterval(() => setTipKey(prev => nextTip(prev)), 6000);
		const onVis = (): void => {
			clearInterval(id);
			if (document.visibilityState === "visible") id = setInterval(() => setTipKey(prev => nextTip(prev)), 6000);
		};
		document.addEventListener("visibilitychange", onVis);
		return () => {
			clearInterval(id);
			document.removeEventListener("visibilitychange", onVis);
		};
	}, []);

	const addImageFiles = async (files: File[]): Promise<void> => {
		const imgs = files.filter(f => f.type.startsWith("image/"));
		if (imgs.length === 0) return;
		// Front-resize large images (TUI parity, images.autoResize-governed).
		const autoResize = await readAutoResizeImages(rpc);
		const entries = await Promise.all(
			imgs.map(async f => {
				const dataUrl = await readFileAsDataURL(f);
				const resized = autoResize ? await resizeImageDataUrl(dataUrl, f.type) : null;
				return {
					id: attachId.current++,
					dataUrl: resized?.dataUrl ?? dataUrl,
					mimeType: resized?.mimeType ?? f.type,
					name: f.name,
				};
			}),
		);
		setAttachments(prev => [...prev, ...entries]);
	};

	const submit = (e: FormEvent<HTMLFormElement>): void => {
		e.preventDefault();
		const trimmed = text.trim();
		if ((!trimmed && quotes.length === 0 && attachments.length === 0) || busy) return;
		const quotePrefix =
			quotes.length > 0 ? `${quotes.map(q => `> ${q.split("\n").join("\n> ")}`).join("\n\n")}\n\n` : "";
		const payload = quotePrefix ? `${quotePrefix}${trimmed}`.trim() : trimmed;
		setText("");
		setQuotes([]);
		setAttachments([]);
		sfxFor("first");
		// Armed modes apply to the session this first prompt creates; the
		// armed chips reset either way (goal needs text to be an objective).
		const applyGoal = goalArmed && trimmed.length > 0;
		setGoalArmed(false);
		setPlanArmed(false);
		void onSubmit(payload, {
			thinkingLevel: thinking,
			modelId,
			images: attachments.map(a => ({
				type: "image" as const,
				data: a.dataUrl.split(",")[1] ?? "",
				mimeType: a.mimeType,
			})),
			planMode: planArmed,
			goalMode: applyGoal,
		});
	};

	return (
		/* Scene content only — the surrounding rounded surface belongs to
		 * ChatView, which renders both the welcome and in-session scenes
		 * inside one container. Focus mode (⌘⇧E) expands the composer to
		 * fill the surface (openchamber parity): brand/greeting/tips hide
		 * and the input grows. */
		<div
			className="gui-welcome gui-pane-glow relative flex h-full flex-1 flex-col items-center justify-center overflow-hidden px-8"
			data-focused={focused ? "1" : undefined}
		>
			{/* Interactive dot-matrix brand backdrop (kimi-style reference):
			 * "MusePi" rasterized into a breathing dot grid with colored
			 * accents, feather edge and click ripples; replaces the static
			 * π watermark. Toggle lives in 设置 → 常规 (omp-gui-dotmatrix). */}
			{dotMatrixOn && <DotMatrixMark text={dotMatrixText || "MusePi"} className="gui-welcome-mark" />}
			<div className="gui-welcome-inner relative z-10 flex w-full max-w-[560px] flex-col items-center">
				{/* Workspace picker (openchamber/ZCode): dropdown list attached
				 * right above the input — current project, open folder, remote. */}
				<div className="gui-brand mb-2 flex items-center gap-2">
					<span className="gui-brand-mark">π</span>
					<BlurText text={t("MusePi")} className="text-[22px] font-bold" />
				</div>
				<p className="gui-welcome-greet mb-4">
					<ShinyText text={greeting()} speed={3.2} />
				</p>
				{/* Project target — an independent row above the composer,
				 * left-aligned (openchamber DraftTargetSelectors). */}
				{onProject && (
					<div className="gui-project-row mb-2 flex w-full min-w-0 items-center gap-1.5 px-0.5">
						<div className="relative z-20" ref={projAnchorRef}>
							<button
								type="button"
								className="gui-project-chip"
								onClick={() => setProjOpen(v => !v)}
								aria-label={t("current project")}
							>
								<Icon name="folder" className="h-3.5 w-3.5" />
								<span className="max-w-[200px] truncate">
									{project ? projectName(project) : t("not in a project")}
								</span>
								<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
							</button>
							{renderProjMenu(
								<>
									{project && (
										<button
											type="button"
											className="gui-view-opt gui-view-opt--active"
											onClick={() => setProjOpen(false)}
										>
											<Icon name="folder" className="h-3.5 w-3.5" />
											<span className="min-w-0 flex-1 truncate">{projectName(project)}</span>
											<Icon name="check" className="h-3 w-3 flex-shrink-0" />
										</button>
									)}
									{/* Saved workspaces (sidebar 项目 tab parity): every folder
									 * the app knows, one tap to switch. Current project is
									 * already listed above with the check — skip it here. */}
									{savedProjects.filter(p => p !== project).length > 0 && (
										<>
											<div className="gui-proj-menu-label">{t("saved workspaces")}</div>
											{savedProjects
												.filter(p => p !== project)
												.map(p => (
													<button
														key={p}
														type="button"
														className="gui-view-opt"
														title={p}
														onClick={() => {
															setProjOpen(false);
															onProject?.(p);
														}}
													>
														<Icon name="folder" className="h-3.5 w-3.5" />
														<span className="min-w-0 flex-1 truncate">{projectName(p)}</span>
													</button>
												))}
											<div className="gui-proj-menu-sep" />
										</>
									)}
									<button
										type="button"
										className="gui-view-opt"
										onClick={() => {
											setProjOpen(false);
											onProject("folder");
										}}
									>
										<Icon name="folder-open" className="h-3.5 w-3.5" />
										<span>{t("open folder")}</span>
									</button>
									<button
										type="button"
										className="gui-view-opt"
										onClick={() => {
											setProjOpen(false);
											onProject("remote");
										}}
									>
										<Icon name="server" className="h-3.5 w-3.5" />
										<span>{t("remote connection")}</span>
									</button>
									{project && (
										<button
											type="button"
											className="gui-view-opt"
											onClick={() => {
												setProjOpen(false);
												onProject("none");
											}}
										>
											<Icon name="folder" className="h-3.5 w-3.5" />
											<span>{t("not in a project")}</span>
										</button>
									)}
								</>,
							)}
						</div>
						{branchInfo && (
							<div className="relative z-20" ref={branchAnchorRef}>
								<button
									type="button"
									className="gui-project-chip"
									onClick={() => setBranchOpen(v => !v)}
									aria-label={t("git branch")}
									title={t("git branch")}
								>
									<Icon name="git-branch" className="h-3.5 w-3.5" />
									<span className="max-w-[160px] truncate">{branchInfo.current ?? "—"}</span>
									<Icon name="arrow-down-s" className="h-3 w-3 opacity-60" />
								</button>
								{renderBranchMenu(
									<>
										{branchInfo.branches.map(b => (
											<button
												key={b}
												type="button"
												className={`gui-view-opt${b === branchInfo.current ? " gui-view-opt--active" : ""}`}
												disabled={switchingBranch}
												onClick={() => {
													if (b === branchInfo.current) {
														setBranchOpen(false);
														return;
													}
													void switchBranch(b);
												}}
											>
												<Icon name="git-branch" className="h-3.5 w-3.5" />
												<span className="min-w-0 flex-1 truncate">{b}</span>
												{b === branchInfo.current && (
													<Icon name="check" className="h-3 w-3 flex-shrink-0" />
												)}
											</button>
										))}
									</>,
								)}
							</div>
						)}
					</div>
				)}
				<form
					ref={formRef}
					className="gui-welcome-form relative w-full"
					onSubmit={submit}
					onFocus={() => setBeamOn(true)}
					onBlur={() => setBeamOn(false)}
				>
					<ComposerFrame
						className="gui-welcome-input"
						hero
						heroActive={beamOn}
						chatInput
						flipAnchor="welcome"
						pet={pet.enabled && pet.mode === "input" ? <PetSprite mood="rest" pet={pet.pet} size={34} /> : null}
						attachments={attachments}
						onRemoveAttachment={id => setAttachments(prev => prev.filter(p => p.id !== id))}
						footerLeft={
							<>
								<AttachMenu
									goalMode={goalArmed}
									planMode={planArmed}
									// Welcome toggles ARM the mode chip only — no popup
									// dialog, no session creation (the input keeps its
									// shape). The first sent message applies the mode
									// to the session it creates.
									onToggleGoal={() => setGoalArmed(v => !v)}
									onTogglePlan={() => setPlanArmed(v => !v)}
									onPickImages={files => void addImageFiles(files)}
									onInsert={token => {
										const ta = taRef.current;
										if (!ta) return;
										ta.focus();
										const start = ta.selectionStart ?? text.length;
										const end = ta.selectionEnd ?? text.length;
										ta.setRangeText(token, start, end, "end");
										setText(ta.value);
									}}
								/>
								{/* Focus mode sits between the attach menu and the model
								 * selector (openchamber ComposerFooter order). */}
								{onToggleFocus && (
									<button
										type="button"
										className={`gui-composer-ico${focused ? " gui-composer-ico--active" : ""}`}
										onClick={onToggleFocus}
										title={t("focus mode")}
										aria-label={t("focus mode")}
										aria-pressed={focused}
									>
										<Icon name="expand-up-down" className="h-3.5 w-3.5" />
									</button>
								)}
								<ModelSelector
									rpc={rpc}
									sessionId={null}
									presetId={presetModelId ?? modelId}
									onSelect={setModelId}
								/>
								<ThinkingSelector
									value={thinking}
									onChange={v => {
										thinkingTouched.current = true;
										setThinking(v);
									}}
									efforts={thinkingEfforts}
								/>
								{/* Armed mode chips (plan/goal): shown IN the button row
								 * right of the thinking selector so the armed state is
								 * visible without opening the attach menu. */}
								{goalArmed && (
									<button
										type="button"
										className="gui-mode-chip gui-mode-chip--armed"
										title={t("next message becomes the goal objective")}
										onClick={() => setGoalArmed(false)}
									>
										<Icon name="target" className="h-3 w-3" />
										<span>{t("goal")}</span>
									</button>
								)}
								{planArmed && (
									<button
										type="button"
										className="gui-mode-chip gui-mode-chip--armed"
										title={t("plan mode")}
										onClick={() => setPlanArmed(false)}
									>
										<Icon name="compass-3" className="h-3 w-3" />
										<span>{t("plan")}</span>
									</button>
								)}
							</>
						}
						footerRight={
							<button
								type="submit"
								className="flex h-8 w-8 items-center justify-center rounded-full bg-[var(--color-accent)] text-[var(--color-accent-fg)] transition-opacity disabled:opacity-40"
								disabled={!canSend}
								aria-label={t("send message")}
							>
								<Icon name="send-plane" className="h-4 w-4" />
							</button>
						}
					>
						<div className="gui-welcome-ta-wrap flex items-start gap-1.5">
							{quotes.length > 0 && (
								<div className="gui-welcome-quotes">
									{quotes.map((q, i) => (
										<div className="gui-quote-card" key={`${i}-${q.slice(0, 32)}`}>
											<div className="gui-quote-text">{q}</div>
											<button
												type="button"
												className="gui-quote-close"
												onClick={() => setQuotes(prev => prev.filter((_, j) => j !== i))}
												title={t("remove quote")}
												aria-label={t("remove quote")}
											>
												<X size={12} />
											</button>
										</div>
									))}
								</div>
							)}
							{renderCompMenu(
								<div
									className="gui-slash-menu gui-slash-menu--rich"
									style={{ minWidth: 300 }}
									ref={completionMenuRef}
								>
									{slashOpen && slashFilter.length > 0 && (
										<>
											<div className="gui-slash-rows">
												{slashFilter.map((c, i) => (
													<SlashRow
														key={c.name}
														item={c}
														active={i === slashIdx}
														onClick={() => insertCompletion("slash", c.name)}
													/>
												))}
											</div>
											<div className="gui-slash-footer">{t("slash completion hints")}</div>
										</>
									)}
									{atOpen &&
										atFilter.length > 0 &&
										atFilter.map((e, i) => (
											<button
												key={e.path}
												type="button"
												className={`gui-model-opt${i === atIdx ? " gui-model-opt--active" : ""}`}
												onClick={() => insertCompletion("at", e.path)}
											>
												<span className="min-w-0 flex-1 truncate">
													{e.isDir ? "📁 " : "📄 "}
													{e.path}
												</span>
											</button>
										))}
									{hashOpen &&
										hashFilter.length > 0 &&
										hashFilter.map((s, i) => (
											<button
												key={s.id}
												type="button"
												className={`gui-model-opt${i === hashIdx ? " gui-model-opt--active" : ""}`}
												onClick={() => insertCompletion("hash", s.id)}
											>
												<span className="min-w-0 flex-1 truncate">
													#{hashLabels.get(s.id) ?? s.cwd ?? s.id}
												</span>
											</button>
										))}
								</div>,
							)}
							<textarea
								ref={el => {
									taRef.current = el;
									compAnchorRef(el);
								}}
								className="w-full min-w-0 flex-1 resize-none bg-transparent px-1 py-3.5 text-[14px] leading-relaxed text-[var(--color-text)] outline-none placeholder:text-[var(--color-text-faint)]"
								rows={3}
								data-focused={focused ? "1" : "0"}
								value={text}
								onPaste={e => {
									const files = [...e.clipboardData.items]
										.filter(i => i.type.startsWith("image/"))
										.map(i => i.getAsFile())
										.filter((f): f is File => f !== null);
									if (files.length > 0) {
										e.preventDefault();
										void addImageFiles(files);
									}
								}}
								onDrop={e => {
									const files = [...e.dataTransfer.files];
									if (files.some(f => f.type.startsWith("image/"))) {
										e.preventDefault();
										void addImageFiles(files);
									}
								}}
								onChange={e => {
									setText(e.target.value);
									if (clearAllRef.current) {
										clearAllRef.current = false;
										if (e.target.value === "") setAttachments([]);
									}
									onCompletionInput(e.target.value);
									// Initial height equals the content height, so
									// first lines never resize the card.
									autosize(taRef.current);
								}}
								onKeyDown={e => {
									// IME composition: the confirming Enter commits the
									// candidate text — never submit while composing.
									if (e.nativeEvent.isComposing || e.keyCode === 229) return;
									// Attachment keyboard flow (WeChat parity): Backspace/
									// Delete on an empty input removes the last image chip;
									// a select-all delete empties attachments too.
									if (e.key === "Backspace" || e.key === "Delete") {
										const ta = taRef.current;
										if (ta) {
											if (ta.value.length === 0 && attachments.length > 0) {
												e.preventDefault();
												setAttachments(prev => prev.slice(0, -1));
												return;
											}
											if (
												ta.selectionStart === 0 &&
												ta.selectionEnd === ta.value.length &&
												ta.value.length > 0
											) {
												clearAllRef.current = true;
											}
										}
									}
									const menus: {
										open: boolean;
										list: unknown[];
										idx: number;
										setIdx: (n: number) => void;
										insert: () => void;
									}[] = [
										{
											open: slashOpen,
											list: slashFilter,
											idx: slashIdx,
											setIdx: setSlashIdx,
											insert: () =>
												slashFilter[slashIdx] && insertCompletion("slash", slashFilter[slashIdx]!.name),
										},
										{
											open: atOpen,
											list: atFilter,
											idx: atIdx,
											setIdx: setAtIdx,
											insert: () => atFilter[atIdx] && insertCompletion("at", atFilter[atIdx]!.path),
										},
										{
											open: hashOpen,
											list: hashFilter,
											idx: hashIdx,
											setIdx: setHashIdx,
											insert: () => hashFilter[hashIdx] && insertCompletion("hash", hashFilter[hashIdx]!.id),
										},
									];
									for (const m of menus) {
										if (!m.open || m.list.length === 0) continue;
										if (e.key === "ArrowDown") {
											e.preventDefault();
											m.setIdx((m.idx + 1) % m.list.length);
											return;
										}
										if (e.key === "ArrowUp") {
											e.preventDefault();
											m.setIdx((m.idx - 1 + m.list.length) % m.list.length);
											return;
										}
										if (e.key === "Enter" || e.key === "Tab") {
											e.preventDefault();
											m.insert();
											return;
										}
										if (e.key === "Escape") {
											e.preventDefault();
											setSlashOpen(false);
											setAtOpen(false);
											setHashOpen(false);
											return;
										}
									}
									if (e.key === "Enter" && !e.shiftKey) {
										e.preventDefault();
										submit(e as unknown as FormEvent<HTMLFormElement>);
									}
								}}
								placeholder={t(PLACEHOLDER_TIPS[tipIdx]!)}
								spellCheck={(() => {
									try {
										return localStorage.getItem("omp-gui-chat-spellcheck") === "1";
									} catch {
										return false;
									}
								})()}
								autoFocus
								autoComplete="off"
							/>
						</div>
					</ComposerFrame>
				</form>
				{/* Rotating tip with shimmer refresh (key change re-triggers);
				 * t() runs at render time so locale switches land immediately. */}
				<p key={tipKey} className="gui-tip mt-5 text-[14px] text-[var(--color-text-faint)]">
					{t(tipKey)}
				</p>
				{/* Suggestion chips (openchamber new-session parity): one tap
				 * fills the composer; the user hits Enter to send. */}
				<div className="gui-suggest mt-4">
					{(showMore ? ALL_SUGGESTIONS : SUGGESTIONS).map(s => (
						<button key={s.key} type="button" className="gui-suggest-chip" onClick={() => applySuggestion(s.key)}>
							{t(s.labelKey)}
						</button>
					))}
					{!showMore && (
						<button
							type="button"
							className="gui-suggest-chip gui-suggest-chip--more"
							onClick={() => setShowMore(true)}
						>
							+
						</button>
					)}
					{showMore && (
						<button
							type="button"
							className="gui-suggest-chip gui-suggest-chip--more"
							onClick={() => setShowMore(false)}
						>
							{t("more suggestions")}
						</button>
					)}
				</div>
				{/* Real-time reminders (kimi 实时提醒 parity): background-working
				 * sessions (进行中) + completed-but-unread ones below the empty
				 * composer; click opens the session, 一键已读 clears unread. */}
				{reminders && reminders.length > 0 && (
					<RemindersPanel
						reminders={reminders}
						onSelect={onSelectReminder ?? (() => {})}
						onMarkAllRead={onMarkAllRead ?? (() => {})}
					/>
				)}
			</div>
		</div>
	);
}
