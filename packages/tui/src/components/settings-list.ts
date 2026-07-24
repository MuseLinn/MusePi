import { fuzzyFilter } from "../fuzzy.ts";
import { getKeybindings } from "../keybindings.ts";
import type { Component } from "../tui.ts";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils.ts";
import { Input } from "./input.ts";

export interface SettingItem {
	/** Unique identifier for this setting */
	id: string;
	/** Display label (left side) */
	label: string;
	/** Optional description shown when selected */
	description?: string;
	/** Current value to display (right side) */
	currentValue: string;
	/** If provided, Enter/Space cycles through these values */
	values?: string[];
	/** If provided, Enter opens this submenu. Receives current value and done callback. */
	submenu?: (currentValue: string, done: (selectedValue?: string) => void) => Component;
	/**
	 * Optional section name. Consecutive items sharing a section are rendered
	 * under a non-selectable heading row; items without a section render as
	 * before (flat list).
	 */
	section?: string;
}

export interface SettingsListTheme {
	label: (text: string, selected: boolean) => string;
	value: (text: string, selected: boolean) => string;
	description: (text: string) => string;
	cursor: string;
	hint: (text: string) => string;
	/** Optional style for section heading rows; falls back to `hint`. */
	section?: (text: string) => string;
}

/** A render row: either a section heading or a selectable setting item. */
type ListEntry = { kind: "heading"; text: string } | { kind: "item"; item: SettingItem };

/** Insert a heading entry before each run of items that starts a new section. */
function buildEntries(items: SettingItem[]): ListEntry[] {
	const entries: ListEntry[] = [];
	let currentSection: string | undefined;
	for (const item of items) {
		if (item.section !== undefined && item.section !== currentSection) {
			entries.push({ kind: "heading", text: item.section });
		}
		currentSection = item.section;
		entries.push({ kind: "item", item });
	}
	return entries;
}

export interface SettingsListOptions {
	enableSearch?: boolean;
}

export class SettingsList implements Component {
	private items: SettingItem[];
	private filteredItems: SettingItem[];
	private theme: SettingsListTheme;
	private selectedIndex = 0;
	private maxVisible: number;
	private onChange: (id: string, newValue: string) => void;
	private onCancel: () => void;
	private searchInput?: Input;
	private searchEnabled: boolean;

	// Submenu state
	private submenuComponent: Component | null = null;
	private submenuItemIndex: number | null = null;

	// Render rows (section headings interleaved with items)
	private entries: ListEntry[];
	private filteredEntries: ListEntry[];

	constructor(
		items: SettingItem[],
		maxVisible: number,
		theme: SettingsListTheme,
		onChange: (id: string, newValue: string) => void,
		onCancel: () => void,
		options: SettingsListOptions = {},
	) {
		this.items = items;
		this.filteredItems = items;
		this.entries = buildEntries(items);
		this.filteredEntries = this.entries;
		this.maxVisible = maxVisible;
		this.theme = theme;
		this.onChange = onChange;
		this.onCancel = onCancel;
		this.searchEnabled = options.enableSearch ?? false;
		if (this.searchEnabled) {
			this.searchInput = new Input();
		}
		this.selectedIndex = this.firstItemIndex(this.entries);
	}

	/** Index of the first selectable (item) entry, or 0 when none exists. */
	private firstItemIndex(entries: ListEntry[]): number {
		const index = entries.findIndex((entry) => entry.kind === "item");
		return index === -1 ? 0 : index;
	}

	/** Move `steps` selectable entries forward (negative = backward), skipping headings, with wraparound. */
	private moveSelection(entries: ListEntry[], steps: number): void {
		const selectable = entries.reduce<number[]>((acc, entry, index) => {
			if (entry.kind === "item") acc.push(index);
			return acc;
		}, []);
		if (selectable.length === 0) return;
		const position = selectable.indexOf(this.selectedIndex);
		const nextPosition = (position === -1 ? 0 : position + steps + selectable.length) % selectable.length;
		this.selectedIndex = selectable[nextPosition]!;
	}

	/** The currently selected item, if the selection points at an item entry. */
	private selectedItem(entries: ListEntry[]): SettingItem | undefined {
		const entry = entries[this.selectedIndex];
		return entry?.kind === "item" ? entry.item : undefined;
	}

	/** Update an item's currentValue */
	updateValue(id: string, newValue: string): void {
		const item = this.items.find((i) => i.id === id);
		if (item) {
			item.currentValue = newValue;
		}
	}

	invalidate(): void {
		this.submenuComponent?.invalidate?.();
	}

	render(width: number): string[] {
		// If submenu is active, render it instead
		if (this.submenuComponent) {
			return this.submenuComponent.render(width);
		}

		return this.renderMainList(width);
	}

	private renderMainList(width: number): string[] {
		const lines: string[] = [];

		if (this.searchEnabled && this.searchInput) {
			lines.push(...this.searchInput.render(width));
			lines.push("");
		}

		if (this.items.length === 0) {
			lines.push(this.theme.hint("  No settings available"));
			if (this.searchEnabled) {
				this.addHintLine(lines, width);
			}
			return lines;
		}

		const displayEntries = this.searchEnabled ? this.filteredEntries : this.entries;
		const displayItemCount = displayEntries.reduce((count, entry) => (entry.kind === "item" ? count + 1 : count), 0);
		if (displayItemCount === 0) {
			lines.push(truncateToWidth(this.theme.hint("  No matching settings"), width));
			this.addHintLine(lines, width);
			return lines;
		}

		// Calculate visible range with scrolling (headings count as rows)
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(this.maxVisible / 2), displayEntries.length - this.maxVisible),
		);
		const endIndex = Math.min(startIndex + this.maxVisible, displayEntries.length);

		// Calculate max label width for alignment
		const maxLabelWidth = Math.min(30, Math.max(...this.items.map((item) => visibleWidth(item.label))));

		const sectionStyle = this.theme.section ?? this.theme.hint;

		// Render visible entries
		for (let i = startIndex; i < endIndex; i++) {
			const entry = displayEntries[i];
			if (!entry) continue;

			if (entry.kind === "heading") {
				if (lines.length > 0 && lines[lines.length - 1] !== "") {
					lines.push("");
				}
				lines.push(truncateToWidth(sectionStyle(`  ${entry.text}`), width));
				continue;
			}

			const item = entry.item;
			const isSelected = i === this.selectedIndex;
			const prefix = isSelected ? this.theme.cursor : "  ";
			const prefixWidth = visibleWidth(prefix);

			// Pad label to align values
			const labelPadded = item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
			const labelText = this.theme.label(labelPadded, isSelected);

			// Calculate space for value
			const separator = "  ";
			const usedWidth = prefixWidth + maxLabelWidth + visibleWidth(separator);
			const valueMaxWidth = width - usedWidth - 2;

			const valueText = this.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected);

			lines.push(truncateToWidth(prefix + labelText + separator + valueText, width));
		}

		// Add scroll indicator if needed
		if (startIndex > 0 || endIndex < displayEntries.length) {
			const itemPosition = displayEntries
				.slice(0, this.selectedIndex + 1)
				.reduce((count, entry) => (entry.kind === "item" ? count + 1 : count), 0);
			const scrollText = `  (${itemPosition}/${displayItemCount})`;
			lines.push(this.theme.hint(truncateToWidth(scrollText, width - 2, "")));
		}

		// Add description for selected item
		const selected = this.selectedItem(displayEntries);
		if (selected?.description) {
			lines.push("");
			const wrappedDesc = wrapTextWithAnsi(selected.description, width - 4);
			for (const line of wrappedDesc) {
				lines.push(this.theme.description(`  ${line}`));
			}
		}

		// Add hint
		this.addHintLine(lines, width);

		return lines;
	}

	handleInput(data: string): void {
		// If submenu is active, delegate all input to it
		// The submenu's onCancel (triggered by escape) will call done() which closes it
		if (this.submenuComponent) {
			this.submenuComponent.handleInput?.(data);
			return;
		}

		// Main list input handling
		const kb = getKeybindings();
		const displayEntries = this.searchEnabled ? this.filteredEntries : this.entries;
		if (kb.matches(data, "tui.select.up")) {
			this.moveSelection(displayEntries, -1);
		} else if (kb.matches(data, "tui.select.down")) {
			this.moveSelection(displayEntries, 1);
		} else if (kb.matches(data, "tui.select.confirm") || data === " ") {
			this.activateItem();
		} else if (kb.matches(data, "tui.select.cancel")) {
			this.onCancel();
		} else if (this.searchEnabled && this.searchInput) {
			const sanitized = data.replace(/ /g, "");
			if (!sanitized) {
				return;
			}
			this.searchInput.handleInput(sanitized);
			this.applyFilter(this.searchInput.getValue());
		}
	}

	private activateItem(): void {
		const displayEntries = this.searchEnabled ? this.filteredEntries : this.entries;
		const item = this.selectedItem(displayEntries);
		if (!item) return;

		if (item.submenu) {
			// Open submenu, passing current value so it can pre-select correctly
			this.submenuItemIndex = this.selectedIndex;
			this.submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
				if (selectedValue !== undefined) {
					item.currentValue = selectedValue;
					this.onChange(item.id, selectedValue);
				}
				this.closeSubmenu();
			});
		} else if (item.values && item.values.length > 0) {
			// Cycle through values
			const currentIndex = item.values.indexOf(item.currentValue);
			const nextIndex = (currentIndex + 1) % item.values.length;
			const newValue = item.values[nextIndex];
			item.currentValue = newValue;
			this.onChange(item.id, newValue);
		}
	}

	private closeSubmenu(): void {
		this.submenuComponent = null;
		// Restore selection to the item that opened the submenu
		if (this.submenuItemIndex !== null) {
			this.selectedIndex = this.submenuItemIndex;
			this.submenuItemIndex = null;
		}
	}

	private applyFilter(query: string): void {
		// Match against section + label so typing a section name (e.g. "musepi")
		// surfaces every setting in that section.
		this.filteredItems = fuzzyFilter(this.items, query, (item) =>
			item.section ? `${item.section} ${item.label}` : item.label,
		);
		this.filteredEntries = buildEntries(this.filteredItems);
		this.selectedIndex = this.firstItemIndex(this.filteredEntries);
	}

	private addHintLine(lines: string[], width: number): void {
		lines.push("");
		lines.push(
			truncateToWidth(
				this.theme.hint(
					this.searchEnabled
						? "  Type to search · Enter/Space to change · Esc to cancel"
						: "  Enter/Space to change · Esc to cancel",
				),
				width,
			),
		);
	}
}
