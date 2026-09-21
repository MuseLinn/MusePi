import { t } from "@musepi/client-core";
import type { ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Sidebar session search (openchamber SidebarHeader parity): the input row plus
 * the match-count / Escape meta line and the no-match state.
 *
 * The box owns the **draft** text: typing updates local state only, so a
 * keystroke never invalidates the session tree or reruns its search
 * projection. The parent (the sidebar) receives a query only when the user
 * submits it — Enter, an explicit clear, or an empty field — which is what
 * keeps large session lists responsive while typing (openchamber 1.23.2
 * measured 26 sidebar renders per word down to zero).
 *
 * Composition (IME) input never submits: Enter during composition belongs to
 * the candidate window, and `keyCode === 229` covers the browsers that report
 * the key without firing a composition event.
 */
export function SessionSearchBar({
	open,
	query,
	matchCount,
	inputRef,
	onQueryChange,
	onOpenChange,
}: {
	open: boolean;
	/** Committed query — the one the session list is actually filtered by. */
	query: string;
	/** Sessions the committed query kept (0 while there is no query). */
	matchCount: number;
	inputRef: RefObject<HTMLInputElement | null>;
	onQueryChange(query: string): void;
	onOpenChange(open: boolean): void;
}): ReactNode {
	const boxRef = useRef<HTMLDivElement | null>(null);
	const [draft, setDraft] = useState(query);
	const composing = useRef(false);

	// The committed query is the source of truth for the field: submitting
	// normalizes the draft (trimmed) and closing the box clears both, so the
	// box and the filtered tree can never disagree.
	useLayoutEffect(() => {
		setDraft(query);
		composing.current = false;
	}, [query, open]);

	// Focus + select on open: the input mounts together with the open render,
	// so the focus call waits one frame for it to exist.
	useEffect(() => {
		if (!open) return;
		const raf = requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
		return () => cancelAnimationFrame(raf);
	}, [open, inputRef]);

	// Pointer-down anywhere outside dismisses the search (the sidebar clears the
	// query with it, so a hidden filter can never outlive the box). The toolbar
	// toggle is exempt — it closes the search through its own click handler.
	useEffect(() => {
		if (!open || typeof document === "undefined") return;
		const onPointerDown = (event: MouseEvent): void => {
			const box = boxRef.current;
			const target = event.target as Element | null;
			if (target?.closest?.("[data-search-toggle]")) return;
			if (box && !box.contains(event.target as Node)) onOpenChange(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		return () => document.removeEventListener("mousedown", onPointerDown);
	}, [open, onOpenChange]);

	if (!open) return null;

	const clear = (): void => {
		setDraft("");
		if (query !== "") onQueryChange("");
	};
	const hasDraft = draft.length > 0;
	const hasQuery = query.trim().length > 0;
	// Draft differs from the committed query: the list still shows the previous
	// result, so the box advertises the pending submit instead of an empty state.
	const pending = draft.trim() !== query;
	return (
		<div ref={boxRef}>
			{/* openchamber meta line: count on the left, Escape on the right. */}
			<div className="mx-[10px] flex items-center justify-between pb-0.5 text-[11px] text-[var(--color-text-faint)]">
				<span aria-live="polite">
					{!pending && hasQuery && matchCount > 0 ? t("search match count", { count: matchCount }) : ""}
				</span>
				<span>{pending ? t("press enter to search") : t("esc to clear or close")}</span>
			</div>
			<div className="gui-session-search">
				<Icon name="search" className="h-3.5 w-3.5 flex-none" />
				<input
					ref={inputRef}
					className="gui-input min-w-0 flex-1"
					value={draft}
					enterKeyHint="search"
					// Draft-only: nothing is filtered until Enter (or a clear).
					onChange={e => {
						const next = e.target.value;
						setDraft(next);
						if (!composing.current && next.trim().length === 0 && query !== "") onQueryChange("");
					}}
					onCompositionStart={() => {
						composing.current = true;
					}}
					onCompositionEnd={e => {
						composing.current = false;
						if (e.currentTarget.value.trim().length === 0 && query !== "") onQueryChange("");
					}}
					onKeyDown={e => {
						// Enter during IME composition picks a candidate — it must
						// never reach the search.
						if (composing.current || e.nativeEvent.isComposing || e.keyCode === 229) return;
						if (e.key === "Enter") {
							e.preventDefault();
							e.stopPropagation();
							const next = draft.trim();
							if (!e.repeat && next !== query) onQueryChange(next);
							return;
						}
						if (e.key !== "Escape") return;
						// Escape belongs to this field: the window-level bare-Escape
						// interrupt must not see it (escape-stop field ownership), and
						// the first press clears while the second dismisses.
						e.preventDefault();
						e.stopPropagation();
						if (hasDraft || hasQuery) clear();
						else onOpenChange(false);
					}}
					placeholder={t("search sessions…")}
					aria-label={t("search sessions…")}
				/>
				{hasDraft && (
					<button
						type="button"
						className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
						// Keeps focus (and the open search) while the click lands.
						onMouseDown={e => e.preventDefault()}
						onClick={() => {
							clear();
							inputRef.current?.focus();
						}}
						title={t("clear")}
						aria-label={t("clear")}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				)}
			</div>
			{!pending && hasQuery && matchCount === 0 && (
				<p className="px-[10px] py-3 text-[13px] text-[var(--color-text-faint)]">{t("no matching sessions")}</p>
			)}
		</div>
	);
}
