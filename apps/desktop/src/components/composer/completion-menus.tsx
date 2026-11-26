import { Markdown } from "@musepi/client-core";
import { CircleX as CircleXIconData, Info as InfoIconData } from "lucide";
import { MorphIcon } from "morphicons/react";
import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { t } from "../../i18n/index.js";
import { type AtCandidate, type AtCandidateGroup, atCandidateGroup } from "../../lib/at-completion";
import { Icon } from "../../vendor/oc-icons";
import { type SlashEntry, SlashRow } from "../SlashRow";

/** One session row in the "@" menu (session.list shape). */
export interface SessionCompletionEntry {
	id: string;
	timestamp?: string;
	messageCount?: number;
	cwd?: string;
	/** Last activity — the session group sorts by it so the conversation the
	 *  reader just left sits at the top. */
	updatedAt?: string;
	/** Subagent/advisor transcripts are rows under a parent session, not
	 *  conversations the reader starts; they stay out of the reference list. */
	subagent?: boolean;
	advisor?: boolean;
}

/** Transient slash-command output note (TUI parity): /cmd and !bash
 * output lines surface here above the input, styled by level. */
export function SlashNotice({
	level,
	text,
	markdown = false,
}: {
	level: "info" | "error";
	text: string;
	/** Slash-command outputs (e.g. /btw) are prose — render as markdown;
	 *  bash / !command output stays pre-wrap plain text. */
	markdown?: boolean;
}): ReactNode {
	return (
		<div className={`gui-composer-slash-note gui-composer-slash-note--${level}`} role="status" aria-live="polite">
			<MorphIcon
				icon={level === "error" ? CircleXIconData : InfoIconData}
				size={14}
				spring="snappy"
				reducedMotion="user"
				className="h-3.5 w-3.5 shrink-0"
			/>
			{markdown ? (
				<div className="min-w-0 flex-1 gui-composer-slash-note-md">
					<Markdown text={text} />
				</div>
			) : (
				<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
			)}
		</div>
	);
}

/** Splits `text` around the query's first match so the hit can be
 *  emphasised — kimi-code's menus mark what matched instead of leaving the
 *  reader to find it. A query that doesn't occur yields the whole string as
 *  one unhit span. */
function highlightMatch(text: string, query: string): ReactNode {
	const q = query.trim();
	if (q === "") return text;
	const at = text.toLowerCase().indexOf(q.toLowerCase());
	if (at < 0) return text;
	return (
		<>
			{text.slice(0, at)}
			<span className="gui-at-hit">{text.slice(at, at + q.length)}</span>
			{text.slice(at + q.length)}
		</>
	);
}

function atRowKey(entry: AtCandidate, index: number): string {
	return entry.kind === "session" ? `session:${entry.id}` : `file:${entry.insertPath ?? entry.path}:${index}`;
}

const AT_GROUP_LABEL = {
	session: () => t("general.atGroupSessions"),
	file: () => t("general.atGroupFiles"),
} as const satisfies Record<AtCandidateGroup, () => string>;

/** One "@" row: type glyph, name, then the trailing column (a directory, or
 *  the root badge for an extra workspace mount). The name keeps its own
 *  width and the trailing column right-aligns, so a long path can never
 *  push the name out of view. */
function AtRow({
	entry,
	active,
	query,
	onClick,
	sectionStart = false,
	sectionLabel,
}: {
	entry: AtCandidate;
	active: boolean;
	query: string;
	onClick(): void;
	sectionStart?: boolean;
	/** Heading rendered above this row; absent mid-group. */
	sectionLabel?: string;
}): ReactNode {
	const trailing = entry.kind === "session" ? sessionMetaOf(entry) : entry.path;
	return (
		<>
			{sectionLabel !== undefined && (
				<div className={`gui-at-section${sectionStart ? " gui-at-section--after" : ""}`} role="presentation">
					{sectionLabel}
				</div>
			)}{" "}
			<button
				type="button"
				className={`gui-model-opt${active ? " gui-model-opt--active" : ""}`}
				role="option"
				aria-selected={active}
				onMouseDown={ev => ev.preventDefault()}
				onClick={onClick}
			>
				<Icon
					name={entry.kind === "session" ? "chat-1" : entry.isDir ? "folder" : "file"}
					className={`gui-at-icon${entry.kind === "file" && entry.isDir ? " gui-at-icon--dir" : ""}`}
				/>
				<span className="gui-at-name">
					{highlightMatch(entry.name, query)}
					{entry.kind === "file" && entry.isDir && <span className="gui-at-slash">/</span>}
				</span>
				{entry.kind === "file" && entry.rootLabel && <span className="gui-at-root">{entry.rootLabel}</span>}
				{trailing !== "" && <span className="gui-at-meta">{trailing}</span>}
			</button>
		</>
	);
}

/** Session rows carry "workspace · last activity" in their trailing column —
 *  two sessions with the same title are told apart by where and when. */
function sessionMetaOf(entry: Extract<AtCandidate, { kind: "session" }>): string {
	const parts: string[] = [];
	const dir = entry.cwd?.split("/").filter(Boolean).at(-1);
	if (dir) parts.push(dir);
	if (entry.updatedAt) {
		const then = Date.parse(entry.updatedAt);
		if (Number.isFinite(then)) parts.push(relativeDay(then));
	}
	return parts.join(" · ");
}

/** "今天 / 昨天 / N 天前" — a session list is read as recency, not clock time. */
function relativeDay(then: number): string {
	const days = Math.floor((Date.now() - then) / 86_400_000);
	if (days <= 0) return t("general.atToday");
	if (days === 1) return t("general.atYesterday");
	if (days < 7) return t("general.atDaysAgo", { days: String(days) });
	return new Date(then).toLocaleDateString(undefined, { month: "numeric", day: "numeric" });
}

/** The three completion menus (@ files, / commands, # sessions) share one
 *  portaled anchor: the textarea. Only one is mounted at a time, so a
 *  single ref tracks whichever is open; the scroll effect keeps the
 *  active row in view while arrow-navigating (the menu scrolls internally
 *  with max-height 300px, overflow-y auto). */
export function CompletionMenus({
	slashOpen,
	slashItems,
	slashIdx,
	onPickSlash,
	atOpen,
	atEntries,
	atIdx,
	atQuery,
	onPickAt,
}: {
	slashOpen: boolean;
	slashItems: SlashEntry[];
	slashIdx: number;
	onPickSlash(name: string): void;
	atOpen: boolean;
	atEntries: AtCandidate[];
	atIdx: number;
	/** Current "@" query — marks the matched substring in each row. */
	atQuery: string;
	onPickAt(entry: AtCandidate): void;
}): ReactNode {
	const menuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		const active = menu.querySelector(".gui-slash-row--active, .gui-model-opt--active");
		active?.scrollIntoView({ block: "nearest" });
	}, [slashIdx, atIdx, slashOpen, atOpen]);
	return (
		<>
			{slashOpen && slashItems.length > 0 && (
				<div className="gui-slash-menu gui-slash-menu--rich" ref={menuRef}>
					<div className="gui-slash-rows">
						{slashItems.map((c, i) => (
							<SlashRow key={c.name} item={c} active={i === slashIdx} onClick={() => onPickSlash(c.name)} />
						))}
					</div>
					<div className="gui-slash-footer">{t("general.slashCompletionHints")}</div>
				</div>
			)}
			{atOpen && atEntries.length > 0 && (
				<div className="gui-slash-menu gui-at-menu" ref={menuRef}>
					{atEntries.map((e, i) => {
						const group = atCandidateGroup(e);
						const prev = i > 0 ? atCandidateGroup(atEntries[i - 1]!) : null;
						const label = prev === group ? undefined : AT_GROUP_LABEL[group]();
						return (
							<AtRow
								key={atRowKey(e, i)}
								entry={e}
								active={i === atIdx}
								query={atQuery}
								sectionLabel={label}
								sectionStart={i > 0}
								onClick={() => onPickAt(e)}
							/>
						);
					})}
				</div>
			)}
		</>
	);
}
