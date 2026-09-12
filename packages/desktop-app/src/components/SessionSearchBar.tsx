import { t } from "@musepi/guest-client";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef } from "react";
import { Icon } from "../vendor/oc-icons";

/**
 * Sidebar session search (openchamber SidebarHeader parity): the input row plus
 * the match-count / Escape meta line and the no-match state. Presentational —
 * the sidebar owns `open`/`query`, so the box and the filtered tree can never
 * disagree. The list pane is skipped by the sidebar while a query matches
 * nothing; the empty state below the input is what the user reads instead of a
 * section's "no sessions yet" fallback.
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
	query: string;
	/** Sessions the query kept (0 while there is no query). */
	matchCount: number;
	inputRef: RefObject<HTMLInputElement | null>;
	onQueryChange(query: string): void;
	onOpenChange(open: boolean): void;
}): ReactNode {
	const boxRef = useRef<HTMLDivElement | null>(null);

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
	const hasQuery = query.trim().length > 0;
	return (
		<div ref={boxRef}>
			{/* openchamber meta line: count on the left, Escape on the right. */}
			<div className="mx-[10px] flex items-center justify-between pb-0.5 text-[11px] text-[var(--color-text-faint)]">
				<span aria-live="polite">
					{hasQuery && matchCount > 0 ? t("search match count", { count: matchCount }) : ""}
				</span>
				<span>{t("esc to clear or close")}</span>
			</div>
			<div className="gui-session-search">
				<Icon name="search" className="h-3.5 w-3.5 flex-none" />
				<input
					ref={inputRef}
					className="gui-input min-w-0 flex-1"
					value={query}
					onChange={e => onQueryChange(e.target.value)}
					onKeyDown={e => {
						if (e.key !== "Escape") return;
						// Escape belongs to this field: the window-level bare-Escape
						// interrupt must not see it (escape-stop field ownership), and
						// the first press clears while the second dismisses.
						e.preventDefault();
						e.stopPropagation();
						if (query) onQueryChange("");
						else onOpenChange(false);
					}}
					placeholder={t("search sessions…")}
					aria-label={t("search sessions…")}
				/>
				{hasQuery && (
					<button
						type="button"
						className="rounded-md p-0.5 text-[var(--color-text-faint)] hover:text-[var(--color-text)]"
						// Keeps focus (and the open search) while the click lands.
						onMouseDown={e => e.preventDefault()}
						onClick={() => {
							onQueryChange("");
							inputRef.current?.focus();
						}}
						title={t("clear")}
						aria-label={t("clear")}
					>
						<Icon name="close" className="h-3 w-3" />
					</button>
				)}
			</div>
			{hasQuery && matchCount === 0 && (
				<p className="px-[10px] py-3 text-[13px] text-[var(--color-text-faint)]">{t("no matching sessions")}</p>
			)}
		</div>
	);
}
