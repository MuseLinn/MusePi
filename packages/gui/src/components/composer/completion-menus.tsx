import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { t } from "../../i18n/index.js";
import { Icon } from "../../vendor/oc-icons";
import { type SlashEntry, SlashRow } from "../SlashRow";

/** One "@" workspace-tree completion row (workspace.tree shape). */
export interface AtCompletionEntry {
	name: string;
	path: string;
	isDir: boolean;
	depth: number;
}

/** One "#" session reference completion row (session.list shape). */
export interface HashCompletionEntry {
	id: string;
	timestamp?: string;
	messageCount?: number;
	cwd?: string;
}

/** Transient slash-command output note (TUI parity): /cmd and !bash
 * output lines surface here above the input, styled by level. */
export function SlashNotice({
	level,
	text,
}: {
	level: "info" | "error";
	text: string;
}): ReactNode {
	return (
		<div
			className={`gui-composer-slash-note gui-composer-slash-note--${level}`}
			role="status"
			aria-live="polite"
		>
			<Icon
				name={level === "error" ? "close-circle" : "information"}
				className="h-3.5 w-3.5 shrink-0"
			/>
			<span className="min-w-0 flex-1 whitespace-pre-wrap break-words">{text}</span>
		</div>
	);
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
	onPickAt,
	hashOpen,
	hashSessions,
	hashIdx,
	hashLabel,
	onPickHash,
}: {
	slashOpen: boolean;
	slashItems: SlashEntry[];
	slashIdx: number;
	onPickSlash(name: string): void;
	atOpen: boolean;
	atEntries: AtCompletionEntry[];
	atIdx: number;
	onPickAt(path: string): void;
	hashOpen: boolean;
	hashSessions: HashCompletionEntry[];
	hashIdx: number;
	hashLabel(e: { id: string; cwd?: string }): string;
	onPickHash(id: string): void;
}): ReactNode {
	const menuRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		const menu = menuRef.current;
		if (!menu) return;
		const active = menu.querySelector(".gui-slash-row--active, .gui-model-opt--active");
		active?.scrollIntoView({ block: "nearest" });
	}, [slashIdx, atIdx, hashIdx, slashOpen, atOpen, hashOpen]);
	return (
		<>
			{hashOpen && hashSessions.length > 0 && (
				<div className="gui-slash-menu" ref={menuRef}>
					{hashSessions.map((e, i) => (
						<button
							key={e.id}
							type="button"
							className={`gui-model-opt${i === hashIdx ? " gui-model-opt--active" : ""}`}
							onMouseDown={ev => ev.preventDefault()}
							onClick={() => onPickHash(e.id)}
						>
							<Icon name="chat-1" className="h-4 w-4 shrink-0 text-[var(--color-text-faint)]" />
							<span className="min-w-0 flex-1 truncate font-medium">#{hashLabel(e)}</span>
							{e.cwd && (
								<span className="max-w-[180px] truncate text-[12px] text-[var(--color-text-faint)]">
									{e.cwd}
								</span>
							)}
						</button>
					))}
				</div>
			)}
			{slashOpen && slashItems.length > 0 && (
				<div className="gui-slash-menu gui-slash-menu--rich" ref={menuRef}>
					<div className="gui-slash-rows">
						{slashItems.map((c, i) => (
							<SlashRow
								key={c.name}
								item={c}
								active={i === slashIdx}
								onClick={() => onPickSlash(c.name)}
							/>
						))}
					</div>
					<div className="gui-slash-footer">{t("slash completion hints")}</div>
				</div>
			)}
			{atOpen && atEntries.length > 0 && (
				<div className="gui-slash-menu" ref={menuRef}>
					{atEntries.map((e, i) => (
						<button
							key={e.path}
							type="button"
							className={`gui-model-opt${i === atIdx ? " gui-model-opt--active" : ""}`}
							onMouseDown={ev => ev.preventDefault()}
							onClick={() => onPickAt(e.path)}
						>
							<Icon
								name={e.isDir ? "folder" : "file"}
								className={`h-4 w-4 shrink-0 ${e.isDir ? "text-[var(--color-accent)]" : "text-[var(--color-text-faint)]"}`}
							/>
							<span className="min-w-0 flex-1 truncate">
								<span className="font-medium">{e.name}</span>
								{e.isDir && <span className="ml-1 text-[12px] text-[var(--color-text-faint)]">/</span>}
							</span>
							<span className="max-w-[200px] truncate text-[12px] text-[var(--color-text-faint)]">
								{e.path}
							</span>
						</button>
					))}
				</div>
			)}
		</>
	);
}
