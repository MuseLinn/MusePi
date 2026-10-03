import { t } from "@musepi/client-core";
import { useEffect, useMemo, useState } from "react";
import {
	bindingLabel,
	getEntry,
	SHORTCUTS,
	SHORTCUTS_CHANGED_EVENT,
	type ShortcutEntry,
} from "../lib/shortcut-registry";
import { Icon } from "../vendor/oc-icons/Icon";
import { DialogFrame } from "./DialogFrame";

/**
 * Keyboard-shortcuts reference (openchamber `HelpDialog` parity).
 *
 * Deliberately NOT a hand-maintained list. openchamber's dialog carries a
 * 167-line literal of sections because its layout decisions (which column,
 * which rows) live in that array; we derive every row from the shortcut
 * registry instead, so the dialog cannot disagree with what the keydown
 * handlers actually do — the failure mode of a duplicated table is a dialog
 * that confidently lists a binding which was rebound months ago.
 *
 * Two properties fall out of that:
 *
 *   - `bindingLabel` is platform-aware (⌘→Ctrl off macOS, ↩→Enter, ⎋→Esc) and
 *     reads the effective binding, so a user's rebind shows up here.
 *   - The registry fires `SHORTCUTS_CHANGED_EVENT`, so a dialog left open
 *     while the user rebinds in Settings updates rather than going stale.
 *
 * Divergence: openchamber hand-assigns each section to a column and says so.
 * We do too, for the same reason — greedy packing keeps the columns balanced
 * but scrambles reading order (a reader would meet 会话 next to 布局), and
 * reading order is the point of grouping. Adding a group therefore means
 * choosing its column here; the registry order is preserved within a column.
 */

interface ShortcutSection {
	groupKey: string;
	entries: ShortcutEntry[];
}

/** Column assignment, by design rather than by packing — see the note above. */
const LEFT_COLUMN_GROUPS: ReadonlySet<string> = new Set([
	"shortcut group session",
	"shortcut group composer",
	"shortcut group selection",
]);

export function ShortcutsDialog({ open, onClose }: { open: boolean; onClose(): void }): React.ReactNode {
	// Re-read on the registry's change event: a rebind in Settings must be
	// visible here immediately, not on the next open.
	const [, bump] = useState(0);
	useEffect(() => {
		if (!open) return;
		const onChanged = (): void => bump(n => n + 1);
		window.addEventListener(SHORTCUTS_CHANGED_EVENT, onChanged);
		return () => window.removeEventListener(SHORTCUTS_CHANGED_EVENT, onChanged);
	}, [open]);

	const sections = useMemo<ShortcutSection[]>(() => {
		const byGroup = new Map<string, ShortcutEntry[]>();
		for (const entry of SHORTCUTS) {
			// Entries without a group still belong in the dialog; park them
			// under an untitled bucket rather than dropping them.
			const key = entry.groupKey ?? "";
			const bucket = byGroup.get(key);
			if (bucket) bucket.push(entry);
			else byGroup.set(key, [entry]);
		}
		return [...byGroup].map(([groupKey, entries]) => ({ groupKey, entries }));
	}, []);

	const left = sections.filter(s => LEFT_COLUMN_GROUPS.has(s.groupKey));
	const right = sections.filter(s => !LEFT_COLUMN_GROUPS.has(s.groupKey));
	const paletteBinding = getEntry("search") ? bindingLabel("search") : "";

	const renderColumn = (column: ShortcutSection[]) => (
		<div className="gui-shortcuts-body flex min-w-0 flex-col gap-5">
			{column.map(section => (
				<section key={section.groupKey || "ungrouped"} className="flex flex-col gap-1.5">
					{section.groupKey && (
						<h4 className="gui-shortcut-group">{t(section.groupKey as Parameters<typeof t>[0])}</h4>
					)}
					{section.entries.map(entry => (
						<div key={entry.id} className="gui-shortcut-row">
							<span className="gui-shortcut-label">{t(entry.labelKey as Parameters<typeof t>[0])}</span>
							<kbd className="gui-shortcut-key">{bindingLabel(entry.id)}</kbd>
						</div>
					))}
				</section>
			))}
			{/* Pro tips ride the tail of the second column: the left one runs
			    longer here, so a full-width block below both would leave a
			    visible gap. */}
			<ul className="gui-shortcut-tips">
				<li>{t("shortcut tips palette", { shortcut: paletteBinding })}</li>
				<li>{t("shortcut tips rebind")}</li>
			</ul>
		</div>
	);

	return (
		<DialogFrame open={open} onClose={onClose} label={t("keyboard shortcuts")} className="gui-dialog--shortcuts">
			<div className="gui-dialog-head">
				<div className="flex items-center gap-2.5">
					<Icon name="command" className="h-5 w-5 text-[var(--color-text-muted)]" />
					<h3 className="gui-dialog-title">{t("keyboard shortcuts")}</h3>
				</div>
			</div>
			<p className="gui-shortcuts-lede">{t("keyboard shortcuts desc")}</p>
			<div className="gui-shortcuts-grid">
				{renderColumn(left)}
				{renderColumn(right)}
			</div>
		</DialogFrame>
	);
}
