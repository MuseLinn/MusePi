// ============================================================
// History Search — Ctrl+R fuzzy search over the editor's prompt history
// (OMP history-search port, pi-native seams: pi-tui fuzzyMatch + Input).
// ============================================================

import {
	type Component,
	Container,
	fuzzyMatch,
	getKeybindings,
	Input,
	Spacer,
	Text,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";

/** Visible result rows. */
const MAX_VISIBLE = 10;

/**
 * Fuzzy-filter history entries by query, best match first. An empty query
 * returns the entries untouched (already newest-first). Pure — unit tested.
 */
export function filterHistoryEntries(entries: readonly string[], query: string): string[] {
	const trimmed = query.trim();
	if (trimmed.length === 0) return [...entries];
	const scored: Array<{ entry: string; score: number; index: number }> = [];
	for (let i = 0; i < entries.length; i++) {
		const entry = entries[i]!;
		const match = fuzzyMatch(trimmed, entry);
		if (match.matches) {
			scored.push({ entry, score: match.score, index: i });
		}
	}
	// Lower score = better match; ties keep history order (newest first)
	scored.sort((a, b) => a.score - b.score || a.index - b.index);
	return scored.map((item) => item.entry);
}

class HistorySearchResults implements Component {
	private results: string[] = [];
	private selectedIndex = 0;

	setResults(results: string[]): void {
		this.results = results;
		this.selectedIndex = 0;
	}

	moveSelection(delta: number): void {
		if (this.results.length === 0) return;
		const next = this.selectedIndex + delta;
		this.selectedIndex = ((next % this.results.length) + this.results.length) % this.results.length;
	}

	getSelected(): string | undefined {
		return this.results[this.selectedIndex];
	}

	invalidate(): void {
		// No cached state to invalidate
	}

	render(width: number): string[] {
		if (this.results.length === 0) {
			return [theme.fg("muted", "  No matching history entries")];
		}
		const lines: string[] = [];
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(MAX_VISIBLE / 2), this.results.length - MAX_VISIBLE),
		);
		const endIndex = Math.min(startIndex + MAX_VISIBLE, this.results.length);
		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.results[i]!;
			const isSelected = i === this.selectedIndex;
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const normalized = entry.replaceAll(/\s+/g, " ").trim();
			const truncated = truncateToWidth(normalized, width - 2);
			lines.push(cursor + (isSelected ? theme.bold(truncated) : theme.fg("muted", truncated)));
		}
		if (this.results.length > MAX_VISIBLE) {
			lines.push(theme.fg("dim", `  (${this.selectedIndex + 1}/${this.results.length})`));
		}
		return lines;
	}
}

/**
 * Ctrl+R history fuzzy-search selector. Typing filters the entries
 * (pi-tui fuzzyMatch), ↑/↓ moves the selection, Enter confirms, Esc cancels.
 */
export class HistorySearchComponent extends Container {
	private input: Input;
	private results: HistorySearchResults;
	private entries: readonly string[];
	private onConfirm: (entry: string) => void;
	private onCancel: () => void;

	constructor(entries: readonly string[], onConfirm: (entry: string) => void, onCancel: () => void) {
		super();
		this.entries = entries;
		this.onConfirm = onConfirm;
		this.onCancel = onCancel;

		this.addChild(new Spacer(1));
		this.addChild(new Text(theme.bold("History Search"), 1, 0));
		this.addChild(
			new Text(theme.fg("muted", "Type to fuzzy-filter · ↑/↓ to move · Enter to recall · Esc to cancel"), 1, 0),
		);
		this.addChild(new DynamicBorder());

		this.input = new Input();
		this.input.onEscape = () => this.onCancel();
		this.input.onSubmit = () => this.confirmSelection();
		this.addChild(this.input);

		this.addChild(new DynamicBorder());

		this.results = new HistorySearchResults();
		this.results.setResults(filterHistoryEntries(this.entries, ""));
		this.addChild(this.results);
	}

	/** Refilter from the current query (exposed for tests). */
	refresh(): void {
		this.results.setResults(filterHistoryEntries(this.entries, this.input.getValue()));
	}

	private confirmSelection(): void {
		const selected = this.results.getSelected();
		if (selected !== undefined) {
			this.onConfirm(selected);
		} else {
			this.onCancel();
		}
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.up")) {
			this.results.moveSelection(-1);
			return;
		}
		if (kb.matches(data, "tui.select.down")) {
			this.results.moveSelection(1);
			return;
		}
		if (kb.matches(data, "tui.select.confirm")) {
			this.confirmSelection();
			return;
		}
		if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
			return;
		}
		this.input.handleInput(data);
		this.refresh();
	}
}
