import { t } from "@musepi/client-core";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import type { KeyboardEvent, ReactNode } from "react";
import { useEffect, useRef } from "react";

/** One ⌘F hit: the row's entry timestamp (the transcript's jump key) plus the
 *  matched message text for the preview line. */
export interface FindHit {
	timestamp: string;
	snippet: string;
}

/**
 * In-conversation find bar (openchamber ⌘F parity).
 *
 * Deliberately presentational: ChatView owns the query, the debounced
 * `session.search` and the selected index, and hands jumps back through
 * `onJumpTo` — the same resolver the TurnRail and the message-tree canvas
 * use, which pages older chunks until the target row materializes before
 * calling `virtualizer.scrollToIndex`. Keeping transcript geometry in one
 * owner is why this bar never touches the virtualizer itself.
 */
export function ChatFind({
	hits,
	index,
	query,
	searching,
	onQuery,
	onPrev,
	onNext,
	onClose,
	onJumpTo,
}: {
	hits: readonly FindHit[];
	/** Index into `hits` of the selected hit, -1 when nothing is selected. */
	index: number;
	query: string;
	searching: boolean;
	onQuery(next: string): void;
	onPrev(): void;
	onNext(): void;
	onClose(): void;
	onJumpTo(hit: FindHit): void;
}): ReactNode {
	const inputRef = useRef<HTMLInputElement | null>(null);

	// ⌘F → type works without a click: select so typing replaces the seed.
	useEffect(() => {
		const el = inputRef.current;
		if (!el) return;
		el.focus();
		el.select();
	}, []);

	const current = hits[index];

	const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
		// Claim the keys: the window-level handler treats an unclaimed Escape
		// as "interrupt the running turn" (lib/escape-stop).
		e.stopPropagation();
		if (e.key === "Escape") {
			e.preventDefault();
			onClose();
		} else if (e.key === "Enter") {
			e.preventDefault();
			if (e.shiftKey) onPrev();
			else onNext();
		}
	};

	// A click on the preview row is the "take me there" affordance — the same
	// reveal a keyboard Enter performs.
	// Hand over the whole hit: the daemon's search rows carry no entry id,
	// so the resolver needs the text to disambiguate a same-millisecond
	// collision (P1-17).
	const reveal = (): void => {
		if (current) onJumpTo(current);
	};

	const counter = searching
		? "…"
		: !query.trim()
			? ""
			: hits.length === 0
				? t("no results")
				: `${index + 1}/${hits.length}`;

	return (
		<div className="gui-find" role="search" aria-label={t("find in chat")}>
			<div className="gui-find-field">
				<input
					ref={inputRef}
					className="gui-find-input"
					value={query}
					placeholder={t("find in chat")}
					spellCheck={false}
					autoComplete="off"
					onChange={e => onQuery(e.target.value)}
					onKeyDown={onKeyDown}
				/>
				<span className="gui-find-count" aria-live="polite">
					{counter}
				</span>
				<button
					type="button"
					className="gui-find-btn"
					onClick={onPrev}
					disabled={hits.length === 0}
					title={t("previous match")}
					aria-label={t("previous match")}
				>
					<ChevronUp size={13} />
				</button>
				<button
					type="button"
					className="gui-find-btn"
					onClick={onNext}
					disabled={hits.length === 0}
					title={t("next match")}
					aria-label={t("next match")}
				>
					<ChevronDown size={13} />
				</button>
				<button
					type="button"
					className="gui-find-btn"
					onClick={onClose}
					title={t("close find bar")}
					aria-label={t("close find bar")}
				>
					<X size={13} />
				</button>
			</div>
			{current && (
				<button type="button" className="gui-find-preview" onClick={reveal} title={t("jump to match")}>
					{current.snippet}
				</button>
			)}
		</div>
	);
}
